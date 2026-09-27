export type WorkerRule = {
  id: number;
  sourceChannelId: number;
  targetChannelId: number;
  nextMessageId: number | null;
  lastForwardedMessageId: number | null;
  messageCount: number;
  scheduleType: string;
  intervalMinutes: number | null;
  fixedTimes: string[];
  timezone: string;
  status: string;
  nextRunAt: Date | null;
  totalForwarded: number;
};

export type WorkerChannel = {
  id: number;
  telegramId: string;
};

export type ForwardingUpdate = Partial<
  Pick<WorkerRule, "nextMessageId" | "lastForwardedMessageId" | "nextRunAt" | "status">
> & {
  incrementForwarded?: number;
  incrementFailed?: number;
  updatedAt?: Date;
};

export type ForwardingStore = {
  listDueRules(now: Date): Promise<WorkerRule[]>;
  getChannel(id: number): Promise<WorkerChannel | undefined>;
  hasHistory(ruleId: number, sourceMessageId: number): Promise<boolean>;
  updateRule(id: number, update: ForwardingUpdate): Promise<void>;
  recordSuccess(input: {
    ruleId: number;
    sourceMessageId: number;
    targetMessageId: number | null;
  }): Promise<void>;
  recordPermanentFailure(input: {
    ruleId: number;
    sourceMessageId: number;
    error: string;
  }): Promise<void>;
  recordError(input: {
    ruleId: number;
    errorType: string;
    message: string;
    retryable: boolean;
  }): Promise<void>;
  getRule(id: number): Promise<WorkerRule | undefined>;
};

export type MtProtoClient = {
  getEntity(identifier: unknown): Promise<unknown>;
  forwardMessages(
    target: unknown,
    options: { messages: number[]; fromPeer: unknown; dropAuthor?: boolean },
  ): Promise<unknown>;
};

export type ForwardingWorkerLogger = {
  info?(data: object, message: string): void;
  warn?(data: object, message: string): void;
  error?(data: object, message: string): void;
};

type Clock = () => Date;

const retryableErrorNames = new Set([
  "FloodWaitError",
  "RPCError",
  "TIMEOUT",
  "ETIMEDOUT",
  "ECONNRESET",
  "NETWORK",
]);

function scheduleNextRun(rule: WorkerRule, now: Date): Date {
  if (rule.scheduleType === "INTERVAL" && rule.intervalMinutes) {
    return new Date(now.getTime() + rule.intervalMinutes * 60_000);
  }
  const times = Array.isArray(rule.fixedTimes) ? rule.fixedTimes : [];
  const zone = rule.timezone || "Asia/Kolkata";
  const zonedParts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .reduce<Record<string, number>>((parts, part) => {
      if (part.type !== "literal") parts[part.type] = Number(part.value);
      return parts;
    }, {});
  const candidates = times
    .map((value) => {
      const [hours, minutes] = value.split(":").map(Number);
      const candidate = zonedDate(
        zonedParts.year,
        zonedParts.month,
        zonedParts.day,
        hours,
        minutes,
        zone,
      );
      if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
      return candidate;
    })
    .filter((candidate) => !Number.isNaN(candidate.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] ?? new Date(now.getTime() + 24 * 60 * 60_000);
}

function zonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const targetWall = Date.UTC(year, month - 1, day, hour, minute);
  const guess = new Date(targetWall);
  const actual = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(guess)
    .reduce<Record<string, number>>((parts, part) => {
      if (part.type !== "literal") parts[part.type] = Number(part.value);
      return parts;
    }, {});
  const actualWall = Date.UTC(
    actual.year,
    actual.month - 1,
    actual.day,
    actual.hour,
    actual.minute,
  );
  return new Date(targetWall + (targetWall - actualWall));
}

function classifyError(error: unknown): {
  type: string;
  message: string;
  retryable: boolean;
  waitMs: number;
} {
  const candidate = error as {
    constructor?: { name?: string };
    message?: string;
    seconds?: number;
  };
  const type = candidate?.constructor?.name ?? "TelegramError";
  const message = candidate?.message ?? String(error);
  const retryable =
    retryableErrorNames.has(type) ||
    /flood|timeout|network|temporar|wait/i.test(message);
  const waitMs =
    typeof candidate?.seconds === "number"
      ? candidate.seconds * 1000
      : retryable
        ? 15_000
        : 0;
  return { type, message, retryable, waitMs };
}

function targetMessageId(value: unknown): number | null {
  if (!value || typeof value !== "object" || !("id" in value)) return null;
  const id = Number((value as { id: unknown }).id);
  return Number.isFinite(id) ? id : null;
}

async function safeGetEntity(client: MtProtoClient, identifier: string) {
  try {
    if (/^-?\d+$/.test(identifier)) {
      return await client.getEntity(Number(identifier));
    }
    return await client.getEntity(identifier);
  } catch {
    const cleaned = identifier.replace(/^-100/, "");
    if (/^\d+$/.test(cleaned)) {
      try {
        return await client.getEntity(Number(cleaned));
      } catch {
        // Ignore
      }
    }
    throw new Error(`Could not resolve entity for: ${identifier}`);
  }
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export class ForwardingWorker {
  private readonly pendingRules = new Set<number>();
  private readonly now: Clock;
  private readonly logger: ForwardingWorkerLogger;
  private readonly store: ForwardingStore;
  private readonly client: MtProtoClient | (() => MtProtoClient);

  constructor(
    store: ForwardingStore,
    client: MtProtoClient | (() => MtProtoClient),
    options: { now?: Clock; logger?: ForwardingWorkerLogger } = {},
  ) {
    this.store = store;
    this.client = client;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? {};
  }

  async runDueRules(): Promise<void> {
    const now = this.now();
    const due = await this.store.listDueRules(now);
    for (const rule of due) {
      if (this.pendingRules.has(rule.id)) continue;
      this.pendingRules.add(rule.id);
      try {
        await this.executeRuleBatch(rule, now);
      } finally {
        this.pendingRules.delete(rule.id);
      }
    }
  }

  private getClient(): MtProtoClient {
    return typeof this.client === "function" ? this.client() : this.client;
  }

  private async executeRuleBatch(initialRule: WorkerRule, now: Date): Promise<void> {
    const currentRule = await this.store.getRule(initialRule.id);
    if (!currentRule || currentRule.status !== "ACTIVE") return;

    const source = await this.store.getChannel(currentRule.sourceChannelId);
    const target = await this.store.getChannel(currentRule.targetChannelId);
    if (!source || !target || currentRule.nextMessageId === null) return;

    let sentInThisBatch = 0;
    const batchLimit = currentRule.messageCount || 10;

    while (sentInThisBatch < batchLimit) {
      const ruleNow = await this.store.getRule(initialRule.id);
      if (!ruleNow || ruleNow.status !== "ACTIVE") break;

      const messageId = ruleNow.nextMessageId;
      if (messageId === null) break;

      if (await this.store.hasHistory(ruleNow.id, messageId)) {
        await this.store.updateRule(ruleNow.id, {
          nextMessageId: messageId + 1,
          updatedAt: now,
        });
        continue;
      }

      try {
        const client = this.getClient();
        const sourceEntity = await safeGetEntity(client, source.telegramId);
        const targetEntity = await safeGetEntity(client, target.telegramId);

        const forwarded = await client.forwardMessages(targetEntity, {
          messages: [messageId],
          fromPeer: sourceEntity,
          dropAuthor: true,
        });

        const targetMsg = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        await this.store.recordSuccess({
          ruleId: ruleNow.id,
          sourceMessageId: messageId,
          targetMessageId: targetMessageId(targetMsg),
        });

        sentInThisBatch++;

        await this.store.updateRule(ruleNow.id, {
          lastForwardedMessageId: messageId,
          nextMessageId: messageId + 1,
          incrementForwarded: 1,
          updatedAt: now,
        });

        this.logger.info?.(
          { ruleId: ruleNow.id, messageId, count: `${sentInThisBatch}/${batchLimit}` },
          "Message forwarded successfully",
        );

        await sleep(1000);
      } catch (error) {
        const failure = classifyError(error);
        try {
          await this.store.recordError({
            ruleId: ruleNow.id,
            errorType: failure.type,
            message: failure.message,
            retryable: failure.retryable,
          });
        } catch {
          // Ignore
        }

        if (failure.retryable) {
          await this.store.updateRule(ruleNow.id, {
            nextRunAt: new Date(now.getTime() + failure.waitMs),
            updatedAt: now,
          });
          break;
        }

        await this.store.updateRule(ruleNow.id, {
          nextMessageId: messageId + 1,
          incrementFailed: 1,
          updatedAt: now,
        });
      }
    }

    // Batch पूरा होने के बाद अगला रन टाइम (जैसे हर 4 घंटे बाद) सेट करें
    const nextRun = scheduleNextRun(initialRule, now);
    await this.store.updateRule(initialRule.id, {
      nextRunAt: nextRun,
      updatedAt: now,
    });
  }
}