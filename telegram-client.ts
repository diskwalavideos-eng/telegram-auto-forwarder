import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";
import { logger } from "../lib/logger";

const apiId = 33037872;
const apiHash = "ae767202558f9d19db4fe3d2b9270db5";
const session = "1BVtsOLMBu00Zmgm9L-jk0Vj0UFv5ah0HJCMPRR1ABEWJe5C9tCxTpY3oP8w4JybbJiczHMGMryqIToHuK7OQAR93VuTcLb8zBlzPPzAvd91Mj8JBHy3EluVYXIPDHdaTNhADOIN4iL_QnZ8ULjGzeLDQPn1H1gOzsqmnMPpwPvrGVU61p4mnJR_LNEO3qnAcjq8agkdgWbcAmSxXM2d9CMNn5NctaWylxoM4I3DQbVNEU6tLE-xKpT-BuNYaTi0VKAzxmV_ZJbFXuCsWwLmGN8jpT97WE9YlAH57iq1k4KqxbGARMTykVYgZcChpHdVZaQfIwqFygsqC_mJ9uCVYJxhmZ08EWms=";

export let telegramClient!: TelegramClient;

export async function startTelegramClient(): Promise<void> {
  try {
    telegramClient = new TelegramClient(
      new StringSession(session.trim()),
      apiId,
      apiHash,
      { connectionRetries: 5, autoReconnect: true },
    );
  } catch {
    throw new Error(
      "TELEGRAM_SESSION_STRING is not a valid Telegram session string.",
    );
  }
  await telegramClient.connect();
  if (!(await telegramClient.checkAuthorization())) {
    throw new Error("The Telegram session is not authorized.");
  }
  logger.info("MTProto Telegram client connected");
}

export async function resolveChannel(value: string): Promise<{
  telegramId: string;
  username: string | null;
  title: string;
}> {
  const inputVal = value.trim();
  let entity: unknown;

  try {
    // 1. Agar private invite link hai (t.me/+... ya t.me/joinchat/...)
    if (inputVal.includes("+") || inputVal.includes("joinchat")) {
      const hashMatch = inputVal.match(/(?:\+|joinchat\/)([a-zA-Z0-9_-]+)/);
      if (!hashMatch || !hashMatch[1]) {
        throw new Error("Invalid private invite link format.");
      }
      const { Api: TelegramApi } = await import("telegram");
      const hash = hashMatch[1];

      let chat: any = null;
      try {
        // Pehle check karein ki invite valid hai ya user pehle se member hai
        const inviteInfo = await telegramClient.invoke(
          new TelegramApi.messages.CheckChatInvite({ hash }),
        );

        if (inviteInfo.className === "ChatInviteAlready") {
          // Agar user pehle se hi participant hai
          chat = (inviteInfo as any).chats?.[0] || (inviteInfo as any).chat;
        } else {
          // Agar member nahi hai, toh join/import karein
          const updates = await telegramClient.invoke(
            new TelegramApi.messages.ImportChatInvite({ hash }),
          );
          chat = (updates as any).chats?.[0];
        }
      } catch (innerErr: any) {
        // Fallback agar USER_ALREADY_PARTICIPANT fir bhi aaye
        if (
          innerErr.errorMessage === "USER_ALREADY_PARTICIPANT" ||
          innerErr.message?.includes("USER_ALREADY_PARTICIPANT")
        ) {
          throw new Error("Aap pehle se is channel ke member hain. Kripya dialogs me se iska username ya ID use karein.");
        }
        throw innerErr;
      }

      if (!chat) throw new Error("Could not resolve private chat via invite link.");
      entity = chat;
    } 
    else {
      // 2. Public link, username ya numeric ID handle karna
      let cleanVal = inputVal;
      if (cleanVal.includes("t.me/")) {
        const parts = cleanVal.split("t.me/");
        cleanVal = parts[parts.length - 1]?.split("/")[0] ?? cleanVal;
      }
      if (cleanVal.startsWith("@")) {
        cleanVal = cleanVal.substring(1);
      }

      const target = /^-?\d+$/.test(cleanVal) ? Number(cleanVal) : cleanVal;
      entity = await telegramClient.getEntity(target);
    }
  } catch (err) {
    throw new Error(`Channel resolve nahi ho paya. Kripya check karein ki link sahi hai.\n(Error: ${err instanceof Error ? err.message : String(err)})`);
  }

  const record = entity as Api.Channel | Api.Chat | Api.User;
  const title =
    ("title" in record && typeof record.title === "string"
      ? record.title
      : "firstName" in record && typeof record.firstName === "string"
        ? record.firstName
        : inputVal);

  const username =
    "username" in record && typeof record.username === "string"
      ? record.username
      : null;

  let rawId = inputVal;
  if ("id" in record && record.id) {
    rawId =
      record.className === "Channel" || record.className === "Chat"
        ? `-100${record.id.toString().replace(/^-100/, "")}`
        : record.id.toString();
  }

  return { telegramId: rawId, username, title };
}

export function channelPeerId(telegramId: string): string {
  return telegramId;
}