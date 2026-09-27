import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { telegramClient } from "./telegram-client";
import { logger } from "../lib/logger";

export type Schedule =
  | { type: "INTERVAL"; minutes: number }
  | { type: "FIXED"; times: string[] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function getNextFixedTime(times: string[], timezone = "Asia/Kolkata"): Date {
  if (!times || times.length === 0) {
    return new Date(Date.now() + 60 * 60 * 1000);
  }

  const sorted = Array.from(new Set(times)).sort();
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = formatter.formatToParts(now);
  const p: Record<string, string> = {};
  for (const { type, value } of parts) {
    p[type] = value;
  }

  const currentHour = parseInt(p.hour, 10);
  const currentMinute = parseInt(p.minute, 10);
  const currentTotalMinutes = currentHour * 60 + currentMinute;
  const currentSeconds = parseInt(p.second, 10);

  for (const timeStr of sorted) {
    const [hStr, mStr] = timeStr.split(":");
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    const targetTotalMinutes = h * 60 + m;

    if (targetTotalMinutes > currentTotalMinutes) {
      const diffMinutes = targetTotalMinutes - currentTotalMinutes;
      return new Date(now.getTime() + diffMinutes * 60 * 1000 - currentSeconds * 1000);
    }
  }

  const [firstHStr, firstMStr] = sorted[0].split(":");
  const firstH = parseInt(firstHStr, 10);
  const firstM = parseInt(firstMStr, 10);
  const targetMinutesTomorrow = 24 * 60 + (firstH * 60 + firstM);
  const diffMinutes = targetMinutesTomorrow - currentTotalMinutes;
  return new Date(now.getTime() + diffMinutes * 60 * 1000 - currentSeconds * 1000);
}

export async function getClientProfile(): Promise<{ username: string | null; firstName: string; id: string | null }> {
  try {
    const me: any = await telegramClient.getMe();
    return {
      username: me.username ? `@${me.username}` : null,
      firstName: me.firstName || "Main Account",
      id: me.id ? me.id.toString() : null,
    };
  } catch {
    return { username: null, firstName: "Main Account", id: null };
  }
}

export async function getBotSetting(key: string, defaultValue: string): Promise<string> {
  const rows = await db.execute(sql`SELECT value FROM bot_settings WHERE key = ${key}`);
  if (rows && (rows as any).rows && (rows as any).rows.length > 0) {
    return String((rows as any).rows[0].value);
  }
  return defaultValue;
}

export async function setBotSetting(key: string, value: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO bot_settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = ${value}
  `);
}

export async function saveChannelMapping(
  userId: number,
  sourceId: number,
  targetId: number,
  scheduleType: "INTERVAL" | "FIXED",
  hoursOrMinutes: number,
  posts: number,
  fixedTimes: string[] = [],
  startAt?: Date
) {
  const existing = await db.execute(sql`
    SELECT id FROM channel_mappings
    WHERE user_id = ${userId}::bigint AND source_channel_id = ${sourceId} AND target_channel_id = ${targetId}
    LIMIT 1
  `);
  const rows = (existing as any).rows;
  const fixedTimesJson = JSON.stringify(fixedTimes);

  if (rows && rows.length > 0) {
    await db.execute(sql`
      UPDATE channel_mappings
      SET schedule_type = ${scheduleType},
          custom_hours = ${hoursOrMinutes},
          fixed_times = ${fixedTimesJson}::jsonb,
          custom_posts = ${posts}
      WHERE id = ${rows[0].id}
    `);
  } else {
    await db.execute(sql`
      INSERT INTO channel_mappings (
        user_id, source_channel_id, target_channel_id, schedule_type,
        custom_hours, fixed_times, custom_posts, start_at, timezone
      ) VALUES (
        ${userId}::bigint, ${sourceId}, ${targetId}, ${scheduleType},
        ${hoursOrMinutes}, ${fixedTimesJson}::jsonb, ${posts}, ${startAt ?? new Date()}, 'Asia/Kolkata'
      )
    `);
  }
}

export async function updateMappingConfig(
  userId: number,
  mappingId: number,
  scheduleType: "INTERVAL" | "FIXED",
  hours: number,
  posts: number,
  fixedTimes: string[] = []
) {
  const fixedTimesJson = JSON.stringify(fixedTimes);

  await db.execute(sql`
    UPDATE channel_mappings 
    SET schedule_type = ${scheduleType},
        custom_hours = ${hours},
        custom_posts = ${posts},
        fixed_times = ${fixedTimesJson}::jsonb
    WHERE id = ${mappingId} AND user_id = ${userId}::bigint
  `);

  const mapping = await getChannelMapping(userId, mappingId);
  if (mapping) {
    if (scheduleType === "INTERVAL") {
      const totalMinutes = Math.max(1, Math.round(hours * 60));
      await db.execute(sql`
        UPDATE forwarding_rules
        SET schedule_type = 'INTERVAL',
            interval_minutes = ${totalMinutes},
            fixed_times = '[]'::jsonb,
            message_count = ${posts},
            next_run_at = NOW() + (${totalMinutes} * INTERVAL '1 minute'),
            updated_at = NOW()
        WHERE user_id = ${userId}::bigint AND source_channel_id = ${mapping.source_id} AND target_channel_id = ${mapping.target_id}
      `);
    } else {
      const nextRun = getNextFixedTime(fixedTimes, "Asia/Kolkata");
      await db.execute(sql`
        UPDATE forwarding_rules
        SET schedule_type = 'FIXED',
            interval_minutes = NULL,
            fixed_times = ${fixedTimesJson}::jsonb,
            message_count = ${posts},
            next_run_at = ${nextRun.toISOString()}::timestamptz,
            updated_at = NOW()
        WHERE user_id = ${userId}::bigint AND source_channel_id = ${mapping.source_id} AND target_channel_id = ${mapping.target_id}
      `);
    }
  }
}

export async function getChannelMapping(userId: number, mappingId: number) {
  const result = await db.execute(sql`
    SELECT M.id, M.schedule_type, M.custom_hours, M.custom_posts, M.fixed_times, M.start_at, M.timezone,
           S.id as source_id, S.title as source_title, S.username as source_username, S.telegram_id as source_telegram_id,
           T.id as target_id, T.title as target_title
    FROM channel_mappings M
    JOIN telegram_channels S ON M.source_channel_id = S.id
    JOIN telegram_channels T ON M.target_channel_id = T.id
    WHERE M.id = ${mappingId} AND M.user_id = ${userId}::bigint
  `);
  const rows = (result as any).rows;
  return rows && rows.length > 0 ? rows[0] : null;
}

export async function listChannelMappings(userId: number) {
  const result = await db.execute(sql`
    SELECT M.id, M.schedule_type, M.custom_hours, M.custom_posts, M.fixed_times, M.start_at, M.timezone,
           S.id as source_id, S.title as source_title, S.username as source_username, S.telegram_id as source_telegram_id,
           T.id as target_id, T.title as target_title
    FROM channel_mappings M
    JOIN telegram_channels S ON M.source_channel_id = S.id
    JOIN telegram_channels T ON M.target_channel_id = T.id
    WHERE M.user_id = ${userId}::bigint
    ORDER BY M.id ASC
  `);
  return (result as any).rows || [];
}

export async function deleteChannelMapping(userId: number, mappingId: number) {
  await db.execute(sql`DELETE FROM channel_mappings WHERE id = ${mappingId} AND user_id = ${userId}::bigint`);
}

export async function resolveFreshEntity(chatId: string | number): Promise<any> {
  const raw = isNaN(Number(chatId)) ? chatId : Number(chatId);
  try {
    return await telegramClient.getEntity(raw);
  } catch {
    try {
      await telegramClient.getDialogs({ limit: 50 });
      return await telegramClient.getEntity(raw);
    } catch {
      return raw;
    }
  }
}

export async function createChannel(
  userId: number,
  kind: "SOURCE" | "TARGET",
  value: string,
): Promise<{ title: string; telegramId: string; username: string | null; adminWarning?: boolean }> {
  const { resolveChannel } = await import("./telegram-client");
  const channel = await resolveChannel(value);

  let adminWarning = false;
  if (kind === "TARGET") {
    try {
      const entity: any = await resolveFreshEntity(channel.telegramId);
      if (entity && entity.className === "Channel") {
        const canPost = Boolean(entity.creator || entity.adminRights?.postMessages);
        if (!canPost) {
          adminWarning = true;
        }
      }
    } catch {}
  }

  const existing = await db.execute(sql`
    SELECT id FROM telegram_channels 
    WHERE user_id = ${userId}::bigint AND kind = ${kind} AND telegram_id = ${channel.telegramId}
    LIMIT 1
  `);
  const rows = (existing as any).rows;

  if (rows && rows.length > 0) {
    await db.execute(sql`
      UPDATE telegram_channels
      SET title = ${channel.title}, username = ${channel.username}
      WHERE id = ${rows[0].id}
    `);
  } else {
    await db.execute(sql`
      INSERT INTO telegram_channels (user_id, kind, telegram_id, username, title)
      VALUES (${userId}::bigint, ${kind}, ${channel.telegramId}, ${channel.username}, ${channel.title})
    `);
  }

  return { ...channel, adminWarning };
}

export async function listChannels(userId: number, kind: "SOURCE" | "TARGET") {
  const res = await db.execute(sql`
    SELECT id, user_id as "userId", kind, telegram_id as "telegramId", username, title, created_at as "createdAt"
    FROM telegram_channels
    WHERE user_id = ${userId}::bigint AND kind = ${kind}
    ORDER BY title ASC
  `);
  return (res as any).rows || [];
}

export async function deleteChannel(userId: number, id: number): Promise<void> {
  await db.execute(sql`DELETE FROM telegram_channels WHERE id = ${id} AND user_id = ${userId}::bigint`);
}

export async function listRules(userId: number) {
  const res = await db.execute(sql`
    SELECT r.id, r.user_id, r.source_channel_id as "sourceChannelId", r.target_channel_id as "targetChannelId",
           r.start_mode as "startMode", r.start_value as "startValue", r.next_message_id as "nextMessageId",
           r.last_forwarded_message_id as "lastForwardedMessageId", r.message_count as "messageCount",
           r.schedule_type as "scheduleType", r.interval_minutes as "intervalMinutes", r.fixed_times as "fixedTimes",
           r.timezone, r.next_run_at as "nextRunAt", r.status, r.total_forwarded as "totalForwarded",
           r.total_failed as "totalFailed",
           s.id as "source_id", s.title as "source_title", s.telegram_id as "source_telegramId", s.username as "source_username"
    FROM forwarding_rules r
    JOIN telegram_channels s ON r.source_channel_id = s.id
    WHERE r.user_id = ${userId}::bigint
    ORDER BY r.id ASC
  `);
  const rows = (res as any).rows || [];
  return rows.map((row: any) => ({
    rule: {
      id: row.id,
      userId: row.user_id,
      sourceChannelId: row.sourceChannelId,
      targetChannelId: row.targetChannelId,
      startMode: row.startMode,
      startValue: row.startValue,
      nextMessageId: row.nextMessageId,
      lastForwardedMessageId: row.lastForwardedMessageId,
      messageCount: row.messageCount,
      scheduleType: row.scheduleType,
      intervalMinutes: row.intervalMinutes,
      fixedTimes: row.fixedTimes,
      timezone: row.timezone,
      nextRunAt: row.nextRunAt ? new Date(row.nextRunAt) : null,
      status: row.status,
      totalForwarded: row.totalForwarded,
      totalFailed: row.totalFailed,
    },
    source: {
      id: row.source_id,
      title: row.source_title,
      telegramId: row.source_telegramId,
      username: row.source_username,
    },
  }));
}

export async function getRule(userId: number, id: number) {
  const rows = await db.execute(sql`
    SELECT * FROM forwarding_rules WHERE id = ${id} AND user_id = ${userId}::bigint LIMIT 1
  `);
  const result = (rows as any).rows;
  return result && result.length > 0 ? result[0] : null;
}

export async function createRule(userId: number, input: {
  sourceChannelId: number;
  targetChannelId: number;
  startValue: string;
  messageCount: number;
  schedule: Schedule;
  active: boolean;
  nextRunAt?: Date;
}) {
  const nextMessageId = Number(input.startValue);
  const parsedCount = Number(input.messageCount);
  const finalMessageCount = Number.isSafeInteger(parsedCount) && parsedCount > 0 ? parsedCount : 10;
  const status = input.active ? "ACTIVE" : "PAUSED";

  let intervalMins: number | null = null;
  let fixedTimesJson = "[]";
  let calculatedNextRun: Date = input.nextRunAt ?? new Date();

  if (input.schedule.type === "INTERVAL") {
    intervalMins = Math.max(1, Math.round(input.schedule.minutes));
  } else {
    fixedTimesJson = JSON.stringify(input.schedule.times);
    if (!input.nextRunAt) {
      calculatedNextRun = getNextFixedTime(input.schedule.times, "Asia/Kolkata");
    }
  }

  await db.execute(sql`
    DELETE FROM forwarding_rules 
    WHERE user_id = ${userId}::bigint 
      AND source_channel_id = ${input.sourceChannelId} 
      AND target_channel_id = ${input.targetChannelId}
  `);

  const res = await db.execute(sql`
    INSERT INTO forwarding_rules (
      user_id, source_channel_id, target_channel_id, start_mode, start_value,
      message_count, next_message_id, schedule_type, interval_minutes, fixed_times,
      timezone, status, total_forwarded, total_failed, next_run_at, created_at, updated_at
    ) VALUES (
      ${userId}::bigint, ${input.sourceChannelId}, ${input.targetChannelId}, 'POST_LINK', ${input.startValue},
      ${finalMessageCount}, ${nextMessageId}, ${input.schedule.type}, ${intervalMins}, ${fixedTimesJson}::jsonb,
      'Asia/Kolkata', ${status}, 0, 0, ${calculatedNextRun.toISOString()}::timestamptz, NOW(), NOW()
    ) RETURNING *
  `);
  const rows = (res as any).rows;
  return rows && rows.length > 0 ? rows[0] : null;
}

export async function setRuleStatus(
  userId: number,
  id: number,
  status: "ACTIVE" | "PAUSED",
): Promise<void> {
  const existing = await getRule(userId, id);
  let nextRunSql = sql`NULL`;

  if (status === "ACTIVE" && existing) {
    if (existing.schedule_type === "FIXED" && Array.isArray(existing.fixed_times)) {
      const nextDate = getNextFixedTime(existing.fixed_times, "Asia/Kolkata");
      nextRunSql = sql`${nextDate.toISOString()}::timestamptz`;
    } else {
      nextRunSql = sql`NOW()`;
    }
  }

  await db.execute(sql`
    UPDATE forwarding_rules
    SET status = ${status},
        next_run_at = ${nextRunSql},
        updated_at = NOW()
    WHERE id = ${id} AND user_id = ${userId}::bigint
  `);
}

export async function deleteRule(userId: number, id: number): Promise<void> {
  await db.execute(sql`DELETE FROM forwarding_rules WHERE id = ${id} AND user_id = ${userId}::bigint`);
}

export async function runDueRules(): Promise<void> {
  try {
    const result = await db.execute(sql`
      SELECT r.id, r.user_id, r.source_channel_id, r.target_channel_id, r.next_message_id, r.message_count,
             r.schedule_type, r.interval_minutes, r.fixed_times, r.total_forwarded,
             s.telegram_id as source_telegram_id, t.telegram_id as target_telegram_id
      FROM forwarding_rules r
      JOIN telegram_channels s ON r.source_channel_id = s.id
      JOIN telegram_channels t ON r.target_channel_id = t.id
      WHERE r.status = 'ACTIVE' AND (r.next_run_at IS NULL OR r.next_run_at <= NOW())
    `);

    const rulesList = (result as any).rows || [];
    for (const rule of rulesList) {
      try {
        const sourceChatId = rule.source_telegram_id;
        const targetChatId = rule.target_telegram_id;
        let currentMsgId = Number(rule.next_message_id);
        const count = Number(rule.message_count) || 10;
        let forwardedInThisCycle = 0;

        const targetEntity: any = await resolveFreshEntity(targetChatId);
        const sourceEntity: any = await resolveFreshEntity(sourceChatId);

        if (targetEntity && targetEntity.className === "Channel") {
          const canPost = Boolean(targetEntity.creator || targetEntity.adminRights?.postMessages);
          if (!canPost) {
            logger.error({
              ruleId: rule.id,
              targetId: targetChatId,
              err: "Main account is NOT an Admin with Post Messages rights in Target Channel!"
            }, "Skipping cycle: Admin rights missing in Target Channel");
            continue;
          }
        }

        let isFloodWait = false;
        let floodWaitSeconds = 0;

        for (let i = 0; i < count; i++) {
          try {
            await telegramClient.forwardMessages(targetEntity, {
              messages: [currentMsgId],
              fromPeer: sourceEntity,
            });

            await db.execute(sql`
              INSERT INTO forwarding_history (rule_id, source_message_id, status)
              VALUES (${rule.id}, ${currentMsgId}, 'SUCCESS')
              ON CONFLICT (rule_id, source_message_id) DO NOTHING
            `);

            forwardedInThisCycle++;

            if (i < count - 1) {
              const jitterMs = 1500 + Math.floor(Math.random() * 1000);
              await sleep(jitterMs);
            }
          } catch (err: any) {
            const errMsg = err?.message || String(err);

            if (err?.seconds || errMsg.includes("FLOOD_WAIT")) {
              floodWaitSeconds = Number(err.seconds) || 60;
              isFloodWait = true;
              logger.warn({
                ruleId: rule.id,
                msgId: currentMsgId,
                seconds: floodWaitSeconds,
              }, "Telegram FloodWait detected! Safe-pausing rule to prevent account ban.");
              break;
            }

            logger.error({
              err: errMsg,
              ruleId: rule.id,
              msgId: currentMsgId,
              sourceId: sourceChatId,
              targetId: targetChatId,
            }, "Failed to forward post");
          }
          currentMsgId++;
        }

        let nextRunAtSql = sql`NOW() + INTERVAL '4 hours'`;

        if (isFloodWait) {
          nextRunAtSql = sql`NOW() + (${floodWaitSeconds + 10} * INTERVAL '1 second')`;
        } else if (rule.schedule_type === "FIXED") {
          const fixedList = Array.isArray(rule.fixed_times) ? rule.fixed_times : [];
          const nextFixedDate = getNextFixedTime(fixedList, "Asia/Kolkata");
          nextRunAtSql = sql`${nextFixedDate.toISOString()}::timestamptz`;
        } else {
          const intervalMins = Number(rule.interval_minutes) || 240;
          nextRunAtSql = sql`NOW() + (${intervalMins} * INTERVAL '1 minute')`;
        }

        await db.execute(sql`
          UPDATE forwarding_rules
          SET next_message_id = ${currentMsgId},
              last_forwarded_message_id = ${currentMsgId - 1},
              total_forwarded = total_forwarded + ${forwardedInThisCycle},
              next_run_at = ${nextRunAtSql},
              updated_at = NOW()
          WHERE id = ${rule.id}
        `);

        logger.info({ ruleId: rule.id, forwarded: forwardedInThisCycle }, "Forwarding cycle executed successfully");
      } catch (ruleErr: any) {
        logger.error({ err: ruleErr?.message || ruleErr, ruleId: rule.id }, "Error in rule execution");
      }
    }
  } catch (err: any) {
    logger.error({ err: err?.message || err }, "Error running due rules scheduler");
  }
}

export async function startForwardingScheduler(): Promise<ReturnType<typeof setInterval>> {
  await runDueRules();
  const timer = setInterval(() => {
    void runDueRules().catch((error) =>
      logger.error({ err: error }, "Forwarding scheduler tick failed"),
    );
  }, 15_000);
  timer.unref();
  logger.info("Forwarding scheduler started");
  return timer;
}

export async function getStatistics(userId: number) {
  const [sourcesRes, targetsRes, rulesRes, totalsRes, errorsRes] = await Promise.all([
    db.execute(sql`SELECT count(*) as count FROM telegram_channels WHERE user_id = ${userId}::bigint AND kind = 'SOURCE'`),
    db.execute(sql`SELECT count(*) as count FROM telegram_channels WHERE user_id = ${userId}::bigint AND kind = 'TARGET'`),
    db.execute(sql`SELECT * FROM forwarding_rules WHERE user_id = ${userId}::bigint`),
    db.execute(sql`SELECT coalesce(sum(total_forwarded), 0) as forwarded, coalesce(sum(total_failed), 0) as failed FROM forwarding_rules WHERE user_id = ${userId}::bigint`),
    db.execute(sql`SELECT count(*) as count FROM telegram_bot_errors WHERE retryable = false`),
  ]);

  const sources = Number((sourcesRes as any).rows?.[0]?.count ?? 0);
  const targets = Number((targetsRes as any).rows?.[0]?.count ?? 0);
  const rules = (rulesRes as any).rows || [];
  const totals = (totalsRes as any).rows?.[0] || { forwarded: 0, failed: 0 };
  const errors = Number((errorsRes as any).rows?.[0]?.count ?? 0);

  const activeRules = rules.filter((r: any) => r.status === "ACTIVE");
  const nextRule = activeRules
    .filter((r: any) => r.next_run_at)
    .sort((a: any, b: any) => new Date(a.next_run_at).getTime() - new Date(b.next_run_at).getTime())[0];

  return {
    sources,
    targets,
    activeRules: activeRules.length,
    totalForwarded: Number(totals.forwarded ?? 0),
    totalFailed: Number(totals.failed ?? 0),
    errors,
    nextRunAt: nextRule?.next_run_at ? new Date(nextRule.next_run_at).toISOString() : null,
  };
}