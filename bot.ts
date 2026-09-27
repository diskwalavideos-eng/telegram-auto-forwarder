import { Bot, InlineKeyboard, type Context } from "grammy";
import { logger } from "../lib/logger";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  createChannel,
  createRule,
  deleteChannel,
  deleteRule,
  getStatistics,
  listChannels,
  listRules,
  setRuleStatus,
  getBotSetting,
  setBotSetting,
  listChannelMappings,
  deleteChannelMapping,
  getChannelMapping,
  updateMappingConfig,
  saveChannelMapping,
  getClientProfile,
  getNextFixedTime,
} from "./forwarder";
import { type RuleFlow } from "./rule-flow";

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminIds = new Set(
  (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0),
);

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (adminIds.size === 0) throw new Error("ADMIN_USER_IDS must contain at least one numeric Telegram user ID");

type Flow =
  | { kind: "CHANNEL"; channelKind: "SOURCE" | "TARGET" }
  | { kind: "SETTING"; settingKey: string }
  | { kind: "CONNECT_SOURCE" }
  | { kind: "CONNECT_TARGET"; sourceChannelId: number }
  | { kind: "CONNECT_LINK"; sourceChannelId: number; targetChannelId: number }
  | { kind: "CONNECT_SCHEDULE_CHOOSE"; sourceChannelId: number; targetChannelId: number; startMsgId: string }
  | { kind: "CONNECT_INTERVAL"; sourceChannelId: number; targetChannelId: number; startMsgId: string }
  | { kind: "CONNECT_FIXED"; sourceChannelId: number; targetChannelId: number; startMsgId: string }
  | { kind: "CONNECT_POSTS"; sourceChannelId: number; targetChannelId: number; startMsgId: string; scheduleType: "INTERVAL" | "FIXED"; hours: number; fixedTimes: string[] }
  | { kind: "MAPPING_START_LINK"; mappingId: number }
  | { kind: "EDIT_MAPPING_INTERVAL"; mappingId: number }
  | { kind: "EDIT_MAPPING_FIXED"; mappingId: number }
  | { kind: "EDIT_MAPPING_POSTS"; mappingId: number }
  | { kind: "EDIT_MAPPING_LINK"; mappingId: number }
  | RuleFlow;

const flows = new Map<number, Flow>();
const liveStatusBoards = new Map<number, NodeJS.Timeout>();

function clearUserBoard(userId: number) {
  if (liveStatusBoards.has(userId)) {
    clearInterval(liveStatusBoards.get(userId)!);
    liveStatusBoards.delete(userId);
  }
}

function isAdmin(ctx: Context): boolean {
  return Boolean(ctx.from?.id && adminIds.has(ctx.from.id));
}

function parseFixedTimes(text: string): string[] | null {
  const parts = text.split(",").map((t) => t.trim());
  const validTimes: string[] = [];
  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

  for (const part of parts) {
    if (!timeRegex.test(part)) return null;
    validTimes.push(part);
  }

  return validTimes.length > 0 ? Array.from(new Set(validTimes)).sort() : null;
}

function mainMenu(isAdminUser: boolean) {
  const keyboard = new InlineKeyboard()
    .text("📥 Sources", "menu:sources")
    .text("📤 Targets", "menu:targets")
    .row()
    .text("🔗 Connect Channels", "menu:connect_start")
    .text("📋 View Connections", "menu:view_connections")
    .row()
    .text("📊 Live Status", "menu:live_status")
    .row()
    .text("⚙️ Settings", "menu:settings")
    .text("📊 Statistics", "menu:stats")
    .row();

  if (isAdminUser) {
    keyboard.text("🛡️ Admin Panel", "admin:panel").row();
  }

  keyboard.text("🔄 Refresh Panel", "menu:restart");
  return keyboard;
}

function formatChannelList(
  title: string,
  channels: Array<{ id: number; title: string; username: string | null }>,
): string {
  if (channels.length === 0) return `${title}\n\nNo channels configured yet.`;
  return `${title}\n\n${channels
    .map((channel, index) => `${index + 1}. ${channel.title}${channel.username ? ` (@${channel.username})` : ""}`)
    .join("\n")}`;
}

async function showMenu(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId) clearUserBoard(userId);

  const defHours = await getBotSetting("default_hours", "4");
  const defPosts = await getBotSetting("default_posts", "10");
  const adminUser = isAdmin(ctx);

  await ctx.reply(
    `⚡ <b>Telegram Auto-Forwarder Pro Panel</b> (Timezone: GMT+05:30 Asia/Kolkata)\n\n` +
    `📌 <b>Global Defaults:</b>\n` +
    `• Interval: <b>${defHours} Hours</b>\n` +
    `• Post Limit: <b>${defPosts} Posts</b>\n\n` +
    `Choose an action below:`,
    { parse_mode: "HTML", reply_markup: mainMenu(adminUser) }
  );
}

async function showSettings(ctx: Context): Promise<void> {
  const defHours = await getBotSetting("default_hours", "4");
  const defPosts = await getBotSetting("default_posts", "10");

  const keyboard = new InlineKeyboard()
    .text(`⏱ Change Default Hours (${defHours}h)`, "setting:edit_hours").row()
    .text(`🔢 Change Default Posts (${defPosts})`, "setting:edit_posts").row()
    .text("⬅️ Back to Main Menu", "menu:home");

  await ctx.reply(
    `⚙️ <b>Global Default Settings Management</b>\n\n` +
    `• Default Hours: <b>${defHours} hrs</b>\n` +
    `• Default Posts Limit: <b>${defPosts} posts</b>`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
}

async function showSources(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const channels = await listChannels(userId, "SOURCE");
  const keyboard = new InlineKeyboard();
  for (const channel of channels) {
    keyboard.text(`Remove ${channel.title}`, `channel:delete:${channel.id}`).row();
  }
  keyboard.text("➕ Add source", "menu:add_source").text("⬅️ Back", "menu:home");
  await ctx.reply(formatChannelList("📥 Source channels", channels), { reply_markup: keyboard });
}

async function showTargets(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const channels = await listChannels(userId, "TARGET");
  const keyboard = new InlineKeyboard();
  for (const channel of channels) {
    keyboard.text(`Remove ${channel.title}`, `channel:delete:${channel.id}`).row();
  }
  keyboard.text("➕ Add target", "menu:add_target").text("⬅️ Back", "menu:home");
  await ctx.reply(formatChannelList("📤 Target channels", channels), { reply_markup: keyboard });
}

async function generateLiveStatusPayload(userId: number) {
  const rules = await listRules(userId);
  const mappings = await listChannelMappings(userId);

  if (rules.length === 0) {
    return {
      text: "📊 <b>Live Status Dashboard</b>\n\nNo active forwarding rules or connections running currently.",
      keyboard: new InlineKeyboard().text("⬅️ Back", "menu:home")
    };
  }

  let text = "📊 <b>All Channels Live Status Board (GMT+5:30 Asia/Kolkata):</b>\n\n";
  const keyboard = new InlineKeyboard();

  for (const r of rules) {
    const rule = r.rule;
    const totalCount = rule.messageCount ?? 0;
    const forwardedCount = rule.totalForwarded ?? 0;

    let nextRunText = "Waiting...";
    if (rule.nextRunAt && rule.status === "ACTIVE") {
      const diffMs = new Date(rule.nextRunAt).getTime() - Date.now();
      if (diffMs > 0) {
        const totalSeconds = Math.floor(diffMs / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        nextRunText = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      } else {
        nextRunText = "Running now...";
      }
    } else {
      nextRunText = "Paused / Completed";
    }

    const statusBadge = rule.status === "ACTIVE" ? "🟢 RUNNING" : "🔴 PAUSED";
    const schedBadge = rule.scheduleType === "FIXED" ? "📅 Fixed Times" : "⏱ Interval";

    text += `📌 <b>Rule #${rule.id}</b> [${statusBadge}] (${schedBadge})\n` +
            `📥 <code>${r.source.title}</code>\n` +
            `• Forwarded: <b>${forwardedCount} / ${totalCount}</b>\n` +
            `• ⏳ Next cycle: <code>${nextRunText}</code>\n\n`;

    const matchedMapping = mappings.find(
      (m: any) => m.source_id === rule.sourceChannelId && m.target_id === rule.targetChannelId
    );

    const toggleLabel = rule.status === "ACTIVE" ? `🛑 Stop` : `▶ Resume`;
    keyboard.text(`#${rule.id}`, "noop")
            .text(toggleLabel, `rule:toggle:${rule.id}`);

    if (matchedMapping) {
      keyboard.text(`⚙️ Edit`, `mapping:edit:${matchedMapping.id}`);
    }

    keyboard.text(`🗑 Delete`, `rule:delete:${rule.id}`).row();
  }

  keyboard.text("🔄 Refresh Now", "menu:live_status").text("⬅️ Back", "menu:home");
  return { text, keyboard };
}

export function createTelegramBot(): Bot {
  const bot = new Bot(token!);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    if (isAdmin(ctx)) {
      return await next();
    }

    try {
      const res = await db.execute(sql`SELECT status FROM user_subscriptions WHERE telegram_id = ${userId}::bigint`);
      const rows = (res as any).rows;

      if (rows && rows.length > 0) {
        if (rows[0].status === "PENDING") {
          await ctx.reply("⏳ <b>Your subscription request is pending admin approval.</b> Please wait.", { parse_mode: "HTML" });
          return;
        } else if (rows[0].status === "BANNED") {
          await ctx.reply("❌ <b>Your account has been banned by the admin.</b>", { parse_mode: "HTML" });
          return;
        } else if (rows[0].status === "REJECTED") {
          if (ctx.callbackQuery && ctx.callbackQuery.data === "sub:request") {
            return await next();
          }
          const keyboard = new InlineKeyboard().text("🚀 Request Subscription / Access", "sub:request");
          await ctx.reply("🔒 <b>Access Restricted.</b> You can request access again:", { parse_mode: "HTML", reply_markup: keyboard });
          return;
        }
      } else {
        if (ctx.callbackQuery && ctx.callbackQuery.data === "sub:request") {
          return await next();
        }
        const keyboard = new InlineKeyboard().text("🚀 Request Subscription / Access", "sub:request");
        await ctx.reply(
          `🔒 <b>Access Restricted</b>\n\nPlease click below to request access from admin:`,
          { parse_mode: "HTML", reply_markup: keyboard }
        );
        return;
      }
    } catch {
      // Fallback
    }

    await next();
  });

  bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("sub:request", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Sending request to admin..." });
    const user = ctx.from;
    if (!user) return;
    const userId = user.id;
    const username = user.username ? `@${user.username}` : "No Username";
    const userNick = user.username ? user.username : null;
    const fullName = ((user.first_name || "") + " " + (user.last_name || "")).trim();

    await db.execute(sql`
      INSERT INTO user_subscriptions (telegram_id, username, full_name, status)
      VALUES (${userId}::bigint, ${userNick}, ${fullName}, 'PENDING')
      ON CONFLICT (telegram_id) DO UPDATE SET status = 'PENDING', requested_at = NOW()
    `);

    await ctx.editMessageText("⏳ <b>Subscription request sent!</b> Please wait for admin approval.", { parse_mode: "HTML" });

    const adminKeyboard = new InlineKeyboard()
      .text("✅ Approve", `sub:approve:${userId}`)
      .text("❌ Reject", `sub:reject:${userId}`)
      .text("🚫 Ban", `sub:ban:${userId}`);

    for (const adminId of adminIds) {
      try {
        await bot.api.sendMessage(
          adminId,
          `🔔 <b>New Subscription Request!</b>\n\n• Name: <b>${fullName}</b>\n• Username: ${username}\n• ID: <code>${userId}</code>`,
          { parse_mode: "HTML", reply_markup: adminKeyboard }
        );
      } catch {}
    }
  });

  bot.callbackQuery("admin:panel", async (ctx) => {
    if (!isAdmin(ctx)) return await ctx.answerCallbackQuery({ text: "Unauthorized", show_alert: true });
    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard()
      .text("📋 View Pending Users", "admin:users:pending").row()
      .text("👥 View All Users", "admin:users:all").row()
      .text("🧹 Reset All System Data", "admin:reset_data").row()
      .text("⬅️ Back to Main Menu", "menu:home");

    await ctx.reply(`🛡️ <b>Admin Management Panel</b>\n\nChoose an option below:`, { parse_mode: "HTML", reply_markup: keyboard });
  });

  bot.callbackQuery("admin:users:pending", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    const res = await db.execute(sql`SELECT telegram_id, full_name, username, status FROM user_subscriptions WHERE status = 'PENDING'`);
    const users = (res as any).rows || [];

    if (users.length === 0) {
      await ctx.reply("📋 No pending subscription requests found.", { reply_markup: new InlineKeyboard().text("⬅️ Back", "admin:panel") });
      return;
    }

    for (const u of users) {
      const kb = new InlineKeyboard()
        .text("✅ Approve", `sub:approve:${u.telegram_id}`)
        .text("❌ Reject", `sub:reject:${u.telegram_id}`)
        .text("🚫 Ban", `sub:ban:${u.telegram_id}`);
      await ctx.reply(`👤 <b>User:</b> ${u.full_name} (@${u.username || "none"})\n🆔 ID: <code>${u.telegram_id}</code>`, { parse_mode: "HTML", reply_markup: kb });
    }
  });

  bot.callbackQuery("admin:users:all", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    const res = await db.execute(sql`SELECT telegram_id, full_name, status FROM user_subscriptions LIMIT 20`);
    const users = (res as any).rows || [];

    let text = "👥 <b>Registered Users (Recent):</b>\n\n";
    const kb = new InlineKeyboard();
    for (const u of users) {
      text += `• ${u.full_name} (<code>${u.telegram_id}</code>) - <b>${u.status}</b>\n`;
      kb.text(`🗑 Reset User Data`, `admin:reset_user:${u.telegram_id}`).row();
    }
    kb.text("⬅️ Back", "admin:panel");
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  });

  bot.callbackQuery(/^admin:reset_user:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const targetUserId = Number(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: "Resetting user..." });
    await db.execute(sql`DELETE FROM user_subscriptions WHERE telegram_id = ${targetUserId}::bigint`);
    await ctx.editMessageText(`✅ User <code>${targetUserId}</code> data reset successfully.`, { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^sub:approve:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const targetId = Number(ctx.match[1]);
    await db.execute(sql`UPDATE user_subscriptions SET status = 'APPROVED' WHERE telegram_id = ${targetId}::bigint`);
    await ctx.answerCallbackQuery({ text: "Approved!" });
    await ctx.editMessageText(`✅ User <code>${targetId}</code> <b>APPROVED</b>.`, { parse_mode: "HTML" });
    try { await bot.api.sendMessage(targetId, "🎉 Your subscription has been approved! Send /start to access the panel."); } catch {}
  });

  bot.callbackQuery(/^sub:reject:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const targetId = Number(ctx.match[1]);
    await db.execute(sql`UPDATE user_subscriptions SET status = 'REJECTED' WHERE telegram_id = ${targetId}::bigint`);
    await ctx.answerCallbackQuery({ text: "Rejected." });
    await ctx.editMessageText(`❌ User <code>${targetId}</code> <b>REJECTED</b>.`, { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^sub:ban:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const targetId = Number(ctx.match[1]);
    await db.execute(sql`UPDATE user_subscriptions SET status = 'BANNED' WHERE telegram_id = ${targetId}::bigint`);
    await ctx.answerCallbackQuery({ text: "Banned." });
    await ctx.editMessageText(`🚫 User <code>${targetId}</code> <b>BANNED</b>.`, { parse_mode: "HTML" });
  });

  bot.callbackQuery("admin:reset_data", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text("⚠️ YES, DELETE ALL DATA", "admin:confirm_reset").row().text("❌ Cancel", "admin:panel");
    await ctx.reply("⚠️ <b>WARNING:</b> This will delete all channels, rules, and mappings across the system! Are you sure?", { parse_mode: "HTML", reply_markup: kb });
  });

  bot.callbackQuery("admin:confirm_reset", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCallbackQuery({ text: "Resetting system..." });
    await db.execute(sql`DELETE FROM channel_mappings`);
    await db.execute(sql`DELETE FROM forwarding_rules`);
    await db.execute(sql`DELETE FROM telegram_channels`);
    await ctx.reply("🧹 <b>All system channels and mappings have been completely reset!</b>", { parse_mode: "HTML", reply_markup: mainMenu(true) });
  });

  bot.command("start", showMenu);
  bot.command("panel", showMenu);
  bot.command("restart", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) clearUserBoard(userId);
    await ctx.reply("🔄 Bot panel refreshed!", { reply_markup: mainMenu(isAdmin(ctx)) });
  });

  bot.callbackQuery("menu:home", async (ctx) => { 
    await ctx.answerCallbackQuery(); 
    const userId = ctx.from?.id;
    if (userId) clearUserBoard(userId);
    await showMenu(ctx); 
  });

  bot.callbackQuery("menu:settings", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) clearUserBoard(userId);
    await ctx.answerCallbackQuery(); 
    await showSettings(ctx); 
  });

  bot.callbackQuery("menu:sources", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) clearUserBoard(userId);
    await ctx.answerCallbackQuery(); 
    await showSources(ctx); 
  });

  bot.callbackQuery("menu:targets", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId) clearUserBoard(userId);
    await ctx.answerCallbackQuery(); 
    await showTargets(ctx); 
  });

  bot.callbackQuery("menu:live_status", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    clearUserBoard(userId);

    const payload = await generateLiveStatusPayload(userId);
    const sentMsg = await ctx.reply(payload.text, { parse_mode: "HTML", reply_markup: payload.keyboard });

    if (sentMsg && sentMsg.chat && sentMsg.message_id) {
      let lastText = payload.text;
      const boardInterval = setInterval(async () => {
        try {
          const updatedPayload = await generateLiveStatusPayload(userId);
          if (updatedPayload.text !== lastText) {
            lastText = updatedPayload.text;
            await bot.api.editMessageText(
              sentMsg.chat.id,
              sentMsg.message_id,
              updatedPayload.text,
              { parse_mode: "HTML", reply_markup: updatedPayload.keyboard }
            ).catch((err: any) => {
              if (err?.error_code === 429) {
                clearUserBoard(userId);
              }
            });
          }
        } catch (err: any) {
          if (err?.error_code === 429) {
            clearUserBoard(userId);
          }
        }
      }, 4000);
      liveStatusBoards.set(userId, boardInterval);
    }
  });

  bot.callbackQuery("menu:connect_start", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    clearUserBoard(userId);

    const sources = await listChannels(userId, "SOURCE");
    if (sources.length === 0) {
      await ctx.reply("❌ Please add a source channel first.", { reply_markup: new InlineKeyboard().text("Add Source", "menu:add_source") });
      return;
    }
    flows.set(userId, { kind: "CONNECT_SOURCE" });
    const keyboard = new InlineKeyboard();
    for (const src of sources) {
      keyboard.text(src.title, `connect:source:${src.id}`).row();
    }
    keyboard.text("⬅️ Back", "menu:home");
    await ctx.reply("🔗 <b>Connect Channels</b>\n\nSelect the <b>Source Channel</b> you want to connect:", { parse_mode: "HTML", reply_markup: keyboard });
  });

  bot.callbackQuery(/^connect:source:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    clearUserBoard(userId);

    const sourceId = Number(ctx.match[1]);
    const targets = await listChannels(userId, "TARGET");
    if (targets.length === 0) {
      await ctx.reply("❌ Please add a target channel first.", { reply_markup: new InlineKeyboard().text("Add Target", "menu:add_target") });
      return;
    }
    
    flows.set(userId, { kind: "CONNECT_TARGET", sourceChannelId: sourceId });
    const keyboard = new InlineKeyboard();
    for (const tgt of targets) {
      keyboard.text(tgt.title, `connect:target:${tgt.id}`).row();
    }
    keyboard.text("⬅️ Back", "menu:connect_start");
    await ctx.reply("🔗 <b>Connect Channels</b>\n\nSelect the <b>Target Channel</b> to link with this source:", { parse_mode: "HTML", reply_markup: keyboard });
  });

  bot.callbackQuery(/^connect:target:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    clearUserBoard(userId);

    const targetId = Number(ctx.match[1]);
    const flow = flows.get(userId);
    if (!flow || flow.kind !== "CONNECT_TARGET") {
      await ctx.reply("❌ Session expired. Please start channel connection again.", { reply_markup: mainMenu(isAdmin(ctx)) });
      return;
    }

    const sourceId = flow.sourceChannelId;
    flows.set(userId, { kind: "CONNECT_LINK", sourceChannelId: sourceId, targetChannelId: targetId });

    await ctx.reply(
      `🔗 <b>Connect Channels (Step 3/4)</b>\n\nPlease send the <b>post link</b> or <b>Message ID</b> from the source channel where forwarding should start from:`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery("sched:choose:interval", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    const flow = flows.get(userId);
    if (!flow || flow.kind !== "CONNECT_SCHEDULE_CHOOSE") {
      await ctx.reply("❌ Session expired. Please start connection again.", { reply_markup: mainMenu(isAdmin(ctx)) });
      return;
    }

    flows.set(userId, {
      kind: "CONNECT_INTERVAL",
      sourceChannelId: flow.sourceChannelId,
      targetChannelId: flow.targetChannelId,
      startMsgId: flow.startMsgId,
    });

    await ctx.reply(
      `⏱ <b>Set Forwarding Interval (HH:MM)</b>\n\n` +
      `Enter interval time (Hours:Minutes):\n` +
      `• Example: <code>04:00</code> (Every 4 Hours)\n` +
      `• Example: <code>00:30</code> (Every 30 Minutes)`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery("sched:choose:fixed", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    const flow = flows.get(userId);
    if (!flow || flow.kind !== "CONNECT_SCHEDULE_CHOOSE") {
      await ctx.reply("❌ Session expired. Please start connection again.", { reply_markup: mainMenu(isAdmin(ctx)) });
      return;
    }

    flows.set(userId, {
      kind: "CONNECT_FIXED",
      sourceChannelId: flow.sourceChannelId,
      targetChannelId: flow.targetChannelId,
      startMsgId: flow.startMsgId,
    });

    await ctx.reply(
      `📅 <b>Set Multiple Fixed Times (24-Hour Format IST)</b>\n\n` +
      `Enter one or multiple times separated by commas (,):\n` +
      `• Example: <code>09:00, 14:30, 20:00</code>\n` +
      `• Example: <code>08:00, 12:00, 16:00, 21:00</code>`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery("menu:view_connections", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    clearUserBoard(userId);

    const mappings = await listChannelMappings(userId);
    if (mappings.length === 0) {
      await ctx.reply("📋 <b>Connected Channels List</b>\n\nNo channels are connected yet.", {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🔗 Connect Now", "menu:connect_start").text("⬅️ Back", "menu:home"),
      });
      return;
    }

    const rules = await listRules(userId);
    await ctx.reply(`📋 <b>All Connected Channels (${mappings.length} Links):</b>`, { parse_mode: "HTML" });

    for (let i = 0; i < mappings.length; i++) {
      const m = mappings[i];
      const relatedRule = rules.find((r: any) => r.rule.sourceChannelId === m.source_id && r.rule.targetChannelId === m.target_id);
      const startPostVal = relatedRule ? (relatedRule.rule.startValue ?? "Not set") : "Not running (Deleted)";

      let scheduleInfo = "";
      if (m.schedule_type === "FIXED") {
        const timesList = Array.isArray(m.fixed_times) ? m.fixed_times : [];
        scheduleInfo = `📅 Fixed Times: <b>${timesList.join(", ")} IST</b>`;
      } else {
        const totalSeconds = Math.round(Number(m.custom_hours) * 3600);
        const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
        const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
        scheduleInfo = `⏱ Interval: <b>Every ${hh}:${mm} hrs</b>`;
      }

      const cardText = `🔗 <b>Connection #${i + 1}</b>\n` +
                       `📥 Source: <b>${m.source_title}</b>\n` +
                       `📤 Target: <b>${m.target_title}</b>\n` +
                       `• ${scheduleInfo}\n` +
                       `• 🔢 Posts Limit: <b>${m.custom_posts} posts</b>\n` +
                       `• 📌 Start Post ID: <code>${startPostVal}</code>`;

      const startBtnText = relatedRule && relatedRule.rule.status === "ACTIVE" ? "⚡ Run Now" : "▶️ Start";
      const cardKeyboard = new InlineKeyboard()
        .text(startBtnText, `mapping:start:${m.id}`)
        .text("✏️ Edit", `mapping:edit:${m.id}`)
        .text("❌ Disconnect", `connect:delete:${m.id}`);

      await ctx.reply(cardText, { parse_mode: "HTML", reply_markup: cardKeyboard });
    }

    await ctx.reply("🏠 Navigation:", {
      reply_markup: new InlineKeyboard().text("🔗 Connect New", "menu:connect_start").text("⬅️ Back to Menu", "menu:home")
    });
  });

  bot.callbackQuery(/^mapping:start:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    clearUserBoard(userId);

    const mappingId = Number(ctx.match[1]);
    const mapping = await getChannelMapping(userId, mappingId);
    if (!mapping) {
      await ctx.reply("❌ Connection mapping not found.");
      return;
    }

    const rules = await listRules(userId);
    const relatedRule = rules.find((r: any) => r.rule.sourceChannelId === mapping.source_id && r.rule.targetChannelId === mapping.target_id);

    if (relatedRule) {
      await db.execute(sql`
        UPDATE forwarding_rules
        SET status = 'ACTIVE', next_run_at = NOW(), updated_at = NOW()
        WHERE id = ${relatedRule.rule.id} AND user_id = ${userId}::bigint
      `);
      await ctx.reply(`✅ <b>Forwarding Started!</b>\n\nRule #${relatedRule.rule.id} activate ho gaya hai aur forwarding cycle turant run hoga.`, { parse_mode: "HTML" });
    } else {
      flows.set(userId, { kind: "MAPPING_START_LINK", mappingId });
      await ctx.reply(
        `▶️ <b>Start Forwarding</b>\n\n` +
        `• Source: <b>${mapping.source_title}</b>\n` +
        `• Target: <b>${mapping.target_title}</b>\n\n` +
        `Send source channel <b>Post Link</b> or <b>Message ID</b> to start forwarding:`,
        { parse_mode: "HTML" }
      );
    }
  });

  bot.callbackQuery(/^mapping:edit:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    clearUserBoard(userId);

    const mappingId = Number(ctx.match[1]);
    const mapping = await getChannelMapping(userId, mappingId);
    if (!mapping) {
      await ctx.reply("❌ Mapping not found.");
      return;
    }

    let schedDesc = "";
    if (mapping.schedule_type === "FIXED") {
      const timesList = Array.isArray(mapping.fixed_times) ? mapping.fixed_times : [];
      schedDesc = `Fixed Times: <b>${timesList.join(", ")} IST</b>`;
    } else {
      schedDesc = `Interval: <b>${mapping.custom_hours} Hours</b>`;
    }

    const keyboard = new InlineKeyboard()
      .text("⏱ Change to Interval", `mapping:settype:interval:${mappingId}`).row()
      .text("📅 Change to Fixed Times", `mapping:settype:fixed:${mappingId}`).row()
      .text("🔢 Edit Post Count", `mapping:editposts:${mappingId}`).row()
      .text("🔗 Edit Start Post Link", `mapping:editlink:${mappingId}`).row()
      .text("⬅️ Back to Connections", "menu:view_connections");

    await ctx.reply(
      `✏️ <b>Edit Connection Schedule & Settings</b>\n\n` +
      `• Source: <b>${mapping.source_title}</b>\n` +
      `• Target: <b>${mapping.target_title}</b>\n` +
      `• Current Schedule: ${schedDesc}\n` +
      `• Current Posts: <b>${mapping.custom_posts}</b>`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
  });

  bot.callbackQuery(/^mapping:settype:interval:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    const mappingId = Number(ctx.match[1]);
    flows.set(userId, { kind: "EDIT_MAPPING_INTERVAL", mappingId });
    await ctx.reply(
      `⏱ <b>Edit Interval Time (HH:MM)</b>\n\nEnter new interval in <code>HH:MM</code> format (e.g. <code>02:30</code> or <code>04:00</code>):`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^mapping:settype:fixed:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    const mappingId = Number(ctx.match[1]);
    flows.set(userId, { kind: "EDIT_MAPPING_FIXED", mappingId });
    await ctx.reply(
      `📅 <b>Edit Multiple Fixed Times (24-Hour Format IST)</b>\n\nEnter times separated by commas (,):\n• Example: <code>09:00, 14:00, 20:00</code>`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^mapping:editposts:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    const mappingId = Number(ctx.match[1]);
    const mapping = await getChannelMapping(userId, mappingId);
    flows.set(userId, { kind: "EDIT_MAPPING_POSTS", mappingId });
    await ctx.reply(`🔢 <b>Edit Post Count</b>\n\nEnter new post limit number:\n<code>${mapping ? mapping.custom_posts : 10}</code>`, { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^mapping:editlink:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    const mappingId = Number(ctx.match[1]);
    const mapping = await getChannelMapping(userId, mappingId);
    if (!mapping) return;

    const rules = await listRules(userId);
    const relatedRule = rules.find((r: any) => r.rule.sourceChannelId === mapping.source_id && r.rule.targetChannelId === mapping.target_id);
    const oldLinkOrId = relatedRule ? (relatedRule.rule.startValue ?? "1") : "1";

    flows.set(userId, { kind: "EDIT_MAPPING_LINK", mappingId });
    await ctx.reply(`🔗 <b>Edit Start Post Link / Message ID</b>\n\nSend new post link or message ID:\n<code>${oldLinkOrId}</code>`, { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^connect:delete:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Disconnecting..." });
    const userId = ctx.from?.id;
    if (!userId) return;
    clearUserBoard(userId);

    const mappingId = Number(ctx.match[1]);
    await deleteChannelMapping(userId, mappingId);
    await ctx.reply("✅ Channel connection successfully removed.", { reply_markup: mainMenu(isAdmin(ctx)) });
  });

  bot.callbackQuery("setting:edit_hours", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    flows.set(userId, { kind: "SETTING", settingKey: "default_hours" });
    await ctx.reply("⏱ <b>Set Default Hours</b>\n\nPlease enter number (e.g. <code>4</code>):", { parse_mode: "HTML" });
  });

  bot.callbackQuery("setting:edit_posts", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    flows.set(userId, { kind: "SETTING", settingKey: "default_posts" });
    await ctx.reply("🔢 <b>Set Default Post Limit</b>\n\nPlease enter number (e.g. <code>10</code>):", { parse_mode: "HTML" });
  });

  bot.callbackQuery("menu:restart", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (userId) {
      clearUserBoard(userId);
      flows.delete(userId);
    }
    await ctx.reply("🔄 Refreshed:", { reply_markup: mainMenu(isAdmin(ctx)) });
  });

  bot.callbackQuery("menu:stats", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    clearUserBoard(userId);
    const stats = await getStatistics(userId);
    await ctx.reply(
      `📊 <b>Statistics</b>\n\nSources: ${stats.sources}\nTargets: ${stats.targets}\nActive: ${stats.activeRules}\nForwarded: ${stats.totalForwarded}`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery("menu:add_source", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    clearUserBoard(userId);
    flows.set(userId, { kind: "CHANNEL", channelKind: "SOURCE" });
    await ctx.reply("📥 <b>Add Source Channel</b>\n\nSend source channel link (public/private) or username:", { parse_mode: "HTML" });
  });

  bot.callbackQuery("menu:add_target", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    clearUserBoard(userId);

    const clientMe = await getClientProfile();
    const accountDisplay = clientMe.username ? `<b>${clientMe.username}</b>` : `<b>${clientMe.firstName}</b> (ID: <code>${clientMe.id}</code>)`;

    flows.set(userId, { kind: "CHANNEL", channelKind: "TARGET" });
    await ctx.reply(
      `📤 <b>Add Target Channel</b>\n\n` +
      `⚠️ <b>अनिवार्य निर्देश (जरूर पढ़ें):</b>\n` +
      `मैसेज ऑटो-फॉरवर्ड करने के लिए हमारे मुख्य फॉरवर्डर अकाउंट ${accountDisplay} को अपने टारगेट चैनल में <b>Administrator</b> बनाएं और <b>'Post Messages'</b> की परमिशन अवश्य चालू रखें।\n\n` +
      `<i>(ध्यान दें: बॉट को नहीं, बल्कि ऊपर दिए गए अकाउंट को एडमिन बनाना है!)</i>\n\n` +
      `एडमिन बनाने के बाद अपने टारगेट चैनल का लिंक या यूजरनेम भेजें:`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^channel:delete:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Removing channel..." });
    const userId = ctx.from?.id;
    if (!userId) return;
    clearUserBoard(userId);
    await deleteChannel(userId, Number(ctx.match[1]));
    await ctx.reply("✅ Channel removed successfully.");
  });

  bot.callbackQuery(/^rule:toggle:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    const ruleId = Number(ctx.match[1]);
    const entries = await listRules(userId);
    const entry = entries.find(({ rule }: any) => rule.id === ruleId);
    if (entry) {
      const newStatus = entry.rule.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
      await setRuleStatus(userId, ruleId, newStatus);
      await ctx.answerCallbackQuery({ text: `Rule #${ruleId} is now ${newStatus}` });
    }
  });

  bot.callbackQuery(/^rule:delete:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    const ruleId = Number(ctx.match[1]);
    await deleteRule(userId, ruleId);
    await ctx.reply(`🗑 <b>Rule #${ruleId} deleted successfully!</b>`, { parse_mode: "HTML" });
  });

  bot.on("message:text", async (ctx) => {
    try {
      const userId = ctx.from?.id;
      if (!userId) return;

      const text = ctx.message.text.trim();
      let flow = flows.get(userId);

      // Connect Flow - Step 3: Parse Start Message ID & Offer Schedule Type
      if (flow && flow.kind === "CONNECT_LINK") {
        let startMsgId = text;
        if (startMsgId.includes("t.me/")) {
          const cleanUrl = startMsgId.split("?")[0].replace(/\/+$/, "");
          const parts = cleanUrl.split("/");
          const lastPart = parts[parts.length - 1];
          if (/^\d+$/.test(lastPart)) {
            startMsgId = lastPart;
          }
        }

        if (/^\d+$/.test(startMsgId)) {
          flows.set(userId, {
            kind: "CONNECT_SCHEDULE_CHOOSE",
            sourceChannelId: flow.sourceChannelId,
            targetChannelId: flow.targetChannelId,
            startMsgId,
          });

          const schedKeyboard = new InlineKeyboard()
            .text("⏱ Regular Interval (हर कुछ घंटे)", "sched:choose:interval").row()
            .text("📅 Multiple Fixed Times (निश्चित समय)", "sched:choose:fixed");

          await ctx.reply(
            `⏰ <b>Select Schedule Mode for this Connection:</b>\n\n` +
            `Choose how you want to schedule forwardings:\n` +
            `1. <b>Interval:</b> Runs every X hours/minutes (e.g. Every 2 hours).\n` +
            `2. <b>Multiple Fixed Times:</b> Runs at exact times daily (e.g. 09:00, 14:00, 20:00).`,
            { parse_mode: "HTML", reply_markup: schedKeyboard }
          );
          return;
        } else {
          await ctx.reply("❌ Invalid post link or message ID. Please send a valid Telegram post link or message number.");
          return;
        }
      }

      // Connect Flow - Step 4a: Interval input received
      if (flow && flow.kind === "CONNECT_INTERVAL") {
        let hours = 4;
        if (text.includes(":")) {
          const [hh, mm] = text.split(":");
          hours = parseInt(hh || "0", 10) + parseInt(mm || "0", 10) / 60;
        } else {
          hours = Number(text);
        }

        if (isNaN(hours) || hours <= 0) {
          await ctx.reply("❌ Invalid interval. Please send in <code>HH:MM</code> format (e.g. <code>02:00</code>):", { parse_mode: "HTML" });
          return;
        }

        flows.set(userId, {
          kind: "CONNECT_POSTS",
          sourceChannelId: flow.sourceChannelId,
          targetChannelId: flow.targetChannelId,
          startMsgId: flow.startMsgId,
          scheduleType: "INTERVAL",
          hours,
          fixedTimes: [],
        });

        await ctx.reply(
          `🔢 <b>Set Post Limit (Posts per Cycle)</b>\n\nEnter number of posts to forward each time (e.g. <code>10</code>):`,
          { parse_mode: "HTML" }
        );
        return;
      }

      // Connect Flow - Step 4b: Fixed times input received
      if (flow && flow.kind === "CONNECT_FIXED") {
        const parsedTimes = parseFixedTimes(text);
        if (!parsedTimes) {
          await ctx.reply(
            "❌ Invalid format. Please enter times in 24-hour format separated by commas (e.g. <code>09:00, 14:30, 20:00</code>):",
            { parse_mode: "HTML" }
          );
          return;
        }

        flows.set(userId, {
          kind: "CONNECT_POSTS",
          sourceChannelId: flow.sourceChannelId,
          targetChannelId: flow.targetChannelId,
          startMsgId: flow.startMsgId,
          scheduleType: "FIXED",
          hours: 4,
          fixedTimes: parsedTimes,
        });

        await ctx.reply(
          `🔢 <b>Set Post Limit (Posts per Cycle)</b>\n\nEnter number of posts to forward at each scheduled time (e.g. <code>10</code>):`,
          { parse_mode: "HTML" }
        );
        return;
      }

      // Connect Flow - Step 5: Final Post count received -> Save and activate!
      if (flow && flow.kind === "CONNECT_POSTS") {
        const posts = Number(text);
        if (isNaN(posts) || posts <= 0) {
          await ctx.reply("❌ Please enter a valid positive number for post count (e.g. <code>10</code>):", { parse_mode: "HTML" });
          return;
        }

        await saveChannelMapping(
          userId,
          flow.sourceChannelId,
          flow.targetChannelId,
          flow.scheduleType,
          flow.hours,
          posts,
          flow.fixedTimes,
          new Date()
        );

        if (flow.scheduleType === "INTERVAL") {
          await createRule(userId, {
            sourceChannelId: flow.sourceChannelId,
            targetChannelId: flow.targetChannelId,
            startValue: flow.startMsgId,
            messageCount: posts,
            schedule: { type: "INTERVAL", minutes: Math.round(flow.hours * 60) },
            active: true,
            nextRunAt: new Date(),
          });
        } else {
          await createRule(userId, {
            sourceChannelId: flow.sourceChannelId,
            targetChannelId: flow.targetChannelId,
            startValue: flow.startMsgId,
            messageCount: posts,
            schedule: { type: "FIXED", times: flow.fixedTimes },
            active: true,
          });
        }

        flows.delete(userId);
        await ctx.reply(
          `✅ <b>Channels Connected & Scheduled Successfully!</b>\n\n` +
          `• Schedule Type: <b>${flow.scheduleType === "FIXED" ? "Multiple Fixed Times" : "Interval"}</b>\n` +
          `• Settings: <b>${flow.scheduleType === "FIXED" ? flow.fixedTimes.join(", ") + " IST" : flow.hours + " Hours"}</b>\n` +
          `• Post Count: <b>${posts} posts</b>`,
          { parse_mode: "HTML", reply_markup: mainMenu(isAdmin(ctx)) }
        );
        return;
      }

      // Mapping Start Link Flow (Restarting deleted rule)
      if (flow && flow.kind === "MAPPING_START_LINK") {
        let startMsgId = text;
        if (startMsgId.includes("t.me/")) {
          const cleanUrl = startMsgId.split("?")[0].replace(/\/+$/, "");
          const parts = cleanUrl.split("/");
          const lastPart = parts[parts.length - 1];
          if (/^\d+$/.test(lastPart)) {
            startMsgId = lastPart;
          }
        }

        if (/^\d+$/.test(startMsgId)) {
          const mapping = await getChannelMapping(userId, flow.mappingId);
          if (mapping) {
            if (mapping.schedule_type === "FIXED") {
              const timesList = Array.isArray(mapping.fixed_times) ? mapping.fixed_times : [];
              await createRule(userId, {
                sourceChannelId: mapping.source_id,
                targetChannelId: mapping.target_id,
                startValue: startMsgId,
                messageCount: Number(mapping.custom_posts) || 10,
                schedule: { type: "FIXED", times: timesList },
                active: true,
              });
            } else {
              await createRule(userId, {
                sourceChannelId: mapping.source_id,
                targetChannelId: mapping.target_id,
                startValue: startMsgId,
                messageCount: Number(mapping.custom_posts) || 10,
                schedule: { type: "INTERVAL", minutes: Math.round(Number(mapping.custom_hours) * 60) || 240 },
                active: true,
                nextRunAt: new Date(),
              });
            }
          }
          flows.delete(userId);
          await ctx.reply("✅ <b>Forwarding successfully started and rule recreated!</b>", { parse_mode: "HTML", reply_markup: mainMenu(isAdmin(ctx)) });
          return;
        } else {
          await ctx.reply("❌ Invalid post link or message ID. Please send a valid Telegram post link or message number.");
          return;
        }
      }

      // Edit Mapping Start Link
      if (flow && flow.kind === "EDIT_MAPPING_LINK") {
        let startMsgId = text;
        if (startMsgId.includes("t.me/")) {
          const cleanUrl = startMsgId.split("?")[0].replace(/\/+$/, "");
          const parts = cleanUrl.split("/");
          const lastPart = parts[parts.length - 1];
          if (/^\d+$/.test(lastPart)) {
            startMsgId = lastPart;
          }
        }

        if (/^\d+$/.test(startMsgId)) {
          const mapping = await getChannelMapping(userId, flow.mappingId);
          if (mapping) {
            const rules = await listRules(userId);
            const existing = rules.find((r: any) => r.rule.sourceChannelId === mapping.source_id && r.rule.targetChannelId === mapping.target_id);
            if (existing) await deleteRule(userId, existing.rule.id);

            if (mapping.schedule_type === "FIXED") {
              const timesList = Array.isArray(mapping.fixed_times) ? mapping.fixed_times : [];
              await createRule(userId, {
                sourceChannelId: mapping.source_id,
                targetChannelId: mapping.target_id,
                startValue: startMsgId,
                messageCount: mapping.custom_posts,
                schedule: { type: "FIXED", times: timesList },
                active: true,
              });
            } else {
              await createRule(userId, {
                sourceChannelId: mapping.source_id,
                targetChannelId: mapping.target_id,
                startValue: startMsgId,
                messageCount: mapping.custom_posts,
                schedule: { type: "INTERVAL", minutes: Number(mapping.custom_hours) * 60 },
                active: true,
                nextRunAt: new Date(),
              });
            }
          }
          flows.delete(userId);
          await ctx.reply("✅ <b>Start post link updated successfully!</b>", { parse_mode: "HTML", reply_markup: mainMenu(isAdmin(ctx)) });
          return;
        } else {
          await ctx.reply("❌ Invalid post link or message ID. Please send a valid Telegram post link or message number.");
          return;
        }
      }

      // Edit Mapping Interval
      if (flow && flow.kind === "EDIT_MAPPING_INTERVAL") {
        let hours = 4;
        if (text.includes(":")) {
          const [hh, mm] = text.split(":");
          hours = parseInt(hh || "0", 10) + parseInt(mm || "0", 10) / 60;
        } else {
          hours = Number(text);
        }

        if (isNaN(hours) || hours <= 0) {
          await ctx.reply("❌ Invalid interval. Please send in <code>HH:MM</code> format (e.g. <code>02:30</code>):", { parse_mode: "HTML" });
          return;
        }

        const mapping = await getChannelMapping(userId, flow.mappingId);
        if (mapping) {
          await updateMappingConfig(userId, flow.mappingId, "INTERVAL", hours, mapping.custom_posts, []);
        }
        flows.delete(userId);
        await ctx.reply("✅ <b>Interval updated successfully!</b>", { parse_mode: "HTML", reply_markup: mainMenu(isAdmin(ctx)) });
        return;
      }

      // Edit Mapping Fixed Times
      if (flow && flow.kind === "EDIT_MAPPING_FIXED") {
        const parsedTimes = parseFixedTimes(text);
        if (!parsedTimes) {
          await ctx.reply(
            "❌ Invalid format. Please enter times in 24-hour format separated by commas (e.g. <code>09:00, 14:00, 20:00</code>):",
            { parse_mode: "HTML" }
          );
          return;
        }

        const mapping = await getChannelMapping(userId, flow.mappingId);
        if (mapping) {
          await updateMappingConfig(userId, flow.mappingId, "FIXED", mapping.custom_hours, mapping.custom_posts, parsedTimes);
        }
        flows.delete(userId);
        await ctx.reply(`✅ <b>Fixed times updated to: ${parsedTimes.join(", ")} IST</b>`, { parse_mode: "HTML", reply_markup: mainMenu(isAdmin(ctx)) });
        return;
      }

      // Edit Mapping Posts Limit
      if (flow && flow.kind === "EDIT_MAPPING_POSTS") {
        const posts = Number(text);
        if (posts > 0) {
          const mapping = await getChannelMapping(userId, flow.mappingId);
          if (mapping) {
            const timesList = Array.isArray(mapping.fixed_times) ? mapping.fixed_times : [];
            await updateMappingConfig(userId, flow.mappingId, mapping.schedule_type, mapping.custom_hours, posts, timesList);
          }
          flows.delete(userId);
          await ctx.reply("✅ <b>Post count updated successfully!</b>", { parse_mode: "HTML", reply_markup: mainMenu(isAdmin(ctx)) });
          return;
        }
      }

      if (!flow) return;

      if (flow.kind === "CHANNEL") {
        try {
          const channel = await createChannel(userId, flow.channelKind, text);
          flows.delete(userId);

          let replyText = `✅ <b>Saved Successfully:</b>\n• Title: <b>${channel.title}</b>\n• Telegram ID: <code>${channel.telegramId}</code>`;

          if (channel.adminWarning) {
            const clientMe = await getClientProfile();
            const accountDisplay = clientMe.username ? clientMe.username : clientMe.firstName;
            replyText += `\n\n⚠️ <b>चेतावनी:</b> हमारे मुख्य अकाउंट (${accountDisplay}) को अभी तक इस टारगेट चैनल में <b>Admin (Post Messages परमिशन के साथ)</b> नहीं बनाया गया है! कृपया पहले Admin बनाएं, अन्यथा मैसेज फॉरवर्ड नहीं हो पाएंगे।`;
          }

          await ctx.reply(replyText, { parse_mode: "HTML", reply_markup: mainMenu(isAdmin(ctx)) });
        } catch (error) {
          await ctx.reply(`❌ Error adding channel: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      if (flow.kind === "SETTING") {
        await setBotSetting(flow.settingKey, text);
        flows.delete(userId);
        await ctx.reply(`✅ <b>Setting Updated Successfully!</b>`, { parse_mode: "HTML", reply_markup: mainMenu(isAdmin(ctx)) });
        return;
      }

    } catch (err: any) {
      const detail = err?.cause?.message || err?.detail || err?.message || String(err);
      logger.error({ err }, "Error handling text message in bot");
      await ctx.reply(`❌ Error: ${detail}`);
    }
  });

  bot.catch((error) => logger.error({ err: error.error }, "Telegram bot update failed"));
  return bot;
}

export async function startTelegramBot(): Promise<Bot> {
  const bot = createTelegramBot();
  void bot.start({
    onStart: (info) => logger.info({ username: info.username }, "Telegram subscription bot started"),
  });
  return bot;
}