import assert from "node:assert/strict";
import test from "node:test";
import {
  ForwardingWorker,
  type ForwardingStore,
  type ForwardingUpdate,
  type MtProtoClient,
  type WorkerChannel,
  type WorkerRule,
} from "./forwarding-worker.ts";
import {
  beginRuleFlow,
  chooseRuleSchedule,
  chooseRuleSource,
  chooseRuleStart,
  chooseRuleTarget,
  setFixedRuleSchedule,
  setRuleStartId,
  toRuleInput,
} from "./rule-flow.ts";

type StoredRule = WorkerRule & {
  totalForwarded: number;
  totalFailed: number;
};

class FakeStore implements ForwardingStore {
  readonly channels = new Map<number, WorkerChannel>();
  readonly rules = new Map<number, StoredRule>();
  readonly history = new Map<
    string,
    { status: "SUCCESS" | "FAILED"; targetMessageId?: number | null; error?: string }
  >();
  readonly errors: Array<{
    ruleId: number;
    errorType: string;
    message: string;
    retryable: boolean;
  }> = [];

  async listDueRules(now: Date): Promise<WorkerRule[]> {
    return [...this.rules.values()]
      .filter(
        (rule) =>
          rule.status === "ACTIVE" &&
          rule.nextRunAt !== null &&
          rule.nextRunAt <= now,
      )
      .sort((a, b) => (a.nextRunAt!.getTime() - b.nextRunAt!.getTime()))
      .map((rule) => ({ ...rule }));
  }

  async getChannel(id: number): Promise<WorkerChannel | undefined> {
    return this.channels.get(id);
  }

  async hasHistory(ruleId: number, sourceMessageId: number): Promise<boolean> {
    return this.history.has(this.key(ruleId, sourceMessageId));
  }

  async updateRule(id: number, update: ForwardingUpdate): Promise<void> {
    const rule = this.rules.get(id);
    if (!rule) throw new Error(`Unknown fake rule ${id}`);
    if (update.nextMessageId !== undefined) rule.nextMessageId = update.nextMessageId;
    if (update.lastForwardedMessageId !== undefined) {
      rule.lastForwardedMessageId = update.lastForwardedMessageId;
    }
    if (update.nextRunAt !== undefined) rule.nextRunAt = update.nextRunAt;
    if (update.incrementForwarded) rule.totalForwarded += update.incrementForwarded;
    if (update.incrementFailed) rule.totalFailed += update.incrementFailed;
  }

  async recordSuccess(input: {
    ruleId: number;
    sourceMessageId: number;
    targetMessageId: number | null;
  }): Promise<void> {
    this.history.set(this.key(input.ruleId, input.sourceMessageId), {
      status: "SUCCESS",
      targetMessageId: input.targetMessageId,
    });
  }

  async recordPermanentFailure(input: {
    ruleId: number;
    sourceMessageId: number;
    error: string;
  }): Promise<void> {
    this.history.set(this.key(input.ruleId, input.sourceMessageId), {
      status: "FAILED",
      error: input.error,
    });
  }

  async recordError(input: {
    ruleId: number;
    errorType: string;
    message: string;
    retryable: boolean;
  }): Promise<void> {
    this.errors.push(input);
  }

  addRule(rule: Partial<StoredRule> & Pick<StoredRule, "id">): StoredRule {
    const complete: StoredRule = {
      sourceChannelId: 1,
      targetChannelId: 2,
      nextMessageId: 1,
      lastForwardedMessageId: null,
      scheduleType: "INTERVAL",
      intervalMinutes: 1,
      fixedTimes: [],
      timezone: "UTC",
      status: "ACTIVE",
      nextRunAt: new Date(0),
      totalForwarded: 0,
      totalFailed: 0,
      ...rule,
    };
    this.rules.set(complete.id, complete);
    return complete;
  }

  setHistory(ruleId: number, sourceMessageId: number, status: "SUCCESS" | "FAILED"): void {
    this.history.set(this.key(ruleId, sourceMessageId), { status });
  }

  private key(ruleId: number, sourceMessageId: number): string {
    return `${ruleId}:${sourceMessageId}`;
  }
}

class FloodWaitError extends Error {
  readonly seconds: number;

  constructor(seconds: number) {
    super(`A Telegram flood wait of ${seconds} seconds is required`);
    this.name = "FloodWaitError";
    this.seconds = seconds;
  }
}

class FakeMtProtoClient implements MtProtoClient {
  readonly forwarded: Array<{ target: string; sourceMessageId: number }> = [];
  private readonly failures = new Map<string, Error[]>();

  failOnce(target: string, sourceMessageId: number, error: Error): void {
    this.failures.set(this.key(target, sourceMessageId), [error]);
  }

  async getEntity(identifier: string): Promise<{ identifier: string }> {
    return { identifier };
  }

  async forwardMessages(
    target: { identifier: string },
    options: { messages: number[]; fromPeer: unknown },
  ): Promise<{ id: number }> {
    const sourceMessageId = options.messages[0]!;
    const key = this.key(target.identifier, sourceMessageId);
    const pending = this.failures.get(key);
    if (pending?.length) {
      const error = pending.shift()!;
      throw error;
    }
    this.forwarded.push({ target: target.identifier, sourceMessageId });
    return { id: this.forwarded.length };
  }

  private key(target: string, sourceMessageId: number): string {
    return `${target}:${sourceMessageId}`;
  }
}

test("Telegram forwarding acceptance: fan-out, pause/resume, order, restart, and failures", async () => {
  const now = { value: 0 };
  const clock = () => new Date(now.value);
  const store = new FakeStore();
  store.channels.set(1, { id: 1, telegramId: "source" });
  store.channels.set(2, { id: 2, telegramId: "target-a" });
  store.channels.set(3, { id: 3, telegramId: "target-b" });
  store.addRule({ id: 1, targetChannelId: 2 });
  store.addRule({ id: 2, targetChannelId: 3 });
  const client = new FakeMtProtoClient();
  const worker = new ForwardingWorker(store, client, { now: clock });

  await worker.runDueRules();
  assert.deepEqual(client.forwarded, [
    { target: "target-a", sourceMessageId: 1 },
    { target: "target-b", sourceMessageId: 1 },
  ]);
  assert.equal(store.rules.get(1)!.totalForwarded, 1);
  assert.equal(store.rules.get(2)!.totalForwarded, 1);

  now.value = 60_000;
  await worker.runDueRules();
  assert.deepEqual(client.forwarded, [
    { target: "target-a", sourceMessageId: 1 },
    { target: "target-b", sourceMessageId: 1 },
    { target: "target-a", sourceMessageId: 2 },
    { target: "target-b", sourceMessageId: 2 },
  ]);
  assert.deepEqual(
    client.forwarded.map(({ target, sourceMessageId }) => `${target}:${sourceMessageId}`),
    ["target-a:1", "target-b:1", "target-a:2", "target-b:2"],
  );

  store.rules.get(1)!.status = "PAUSED";
  store.rules.get(1)!.nextRunAt = new Date(now.value);
  now.value += 60_000;
  await worker.runDueRules();
  assert.equal(
    client.forwarded.filter(({ target }) => target === "target-a").length,
    2,
    "paused rules must not forward",
  );
  store.rules.get(1)!.status = "ACTIVE";
  store.rules.get(1)!.nextRunAt = new Date(now.value);
  await worker.runDueRules();
  assert.deepEqual(client.forwarded.at(-1), { target: "target-a", sourceMessageId: 3 });

  const restartStore = new FakeStore();
  restartStore.channels.set(1, { id: 1, telegramId: "source" });
  restartStore.channels.set(2, { id: 2, telegramId: "target-a" });
  restartStore.addRule({ id: 10, targetChannelId: 2, nextMessageId: 7 });
  restartStore.setHistory(10, 7, "SUCCESS");
  const restartClient = new FakeMtProtoClient();
  const restartedWorker = new ForwardingWorker(
    restartStore,
    restartClient,
    { now: () => new Date(0) },
  );
  await restartedWorker.runDueRules();
  assert.equal(restartClient.forwarded.length, 0, "restart must not duplicate recorded history");
  assert.equal(restartStore.rules.get(10)!.nextMessageId, 8);

  const permanentStore = new FakeStore();
  permanentStore.channels.set(1, { id: 1, telegramId: "source" });
  permanentStore.channels.set(2, { id: 2, telegramId: "target-a" });
  permanentStore.addRule({ id: 20, targetChannelId: 2 });
  const permanentClient = new FakeMtProtoClient();
  permanentClient.failOnce("target-a", 1, new Error("message is unavailable"));
  const permanentWorker = new ForwardingWorker(
    permanentStore,
    permanentClient,
    { now: () => new Date(0) },
  );
  await permanentWorker.runDueRules();
  assert.equal(permanentStore.history.get("20:1")?.status, "FAILED");
  assert.equal(permanentStore.rules.get(20)!.nextMessageId, 2);
  assert.equal(permanentStore.rules.get(20)!.totalFailed, 1);
  assert.equal(permanentStore.errors[0]?.retryable, false);

  const retryStore = new FakeStore();
  retryStore.channels.set(1, { id: 1, telegramId: "source" });
  retryStore.channels.set(2, { id: 2, telegramId: "target-a" });
  retryStore.addRule({ id: 30, targetChannelId: 2 });
  const retryClient = new FakeMtProtoClient();
  retryClient.failOnce("target-a", 1, new FloodWaitError(30));
  const retryWorker = new ForwardingWorker(
    retryStore,
    retryClient,
    { now: clock },
  );
  await retryWorker.runDueRules();
  assert.equal(retryStore.rules.get(30)!.nextMessageId, 1);
  assert.equal(retryStore.rules.get(30)!.nextRunAt?.getTime(), now.value + 30_000);
  assert.equal(retryStore.history.has("30:1"), false);
  assert.equal(retryStore.errors[0]?.retryable, true);
  assert.equal(retryStore.errors[0]?.errorType, "FloodWaitError");
  now.value += 29_000;
  await retryWorker.runDueRules();
  assert.equal(retryClient.forwarded.length, 0);
  now.value += 1_000;
  await retryWorker.runDueRules();
  assert.deepEqual(retryClient.forwarded, [{ target: "target-a", sourceMessageId: 1 }]);
});

test("admin rule flow acceptance: every creation state and validation branch", () => {
  let flow = beginRuleFlow();
  assert.equal(flow.step, "SOURCE");
  flow = chooseRuleSource(flow, 11);
  assert.equal(flow.step, "TARGET");
  flow = chooseRuleTarget(flow, 22);
  assert.equal(flow.step, "START");

  const specificStart = chooseRuleStart(flow, "MESSAGE_ID");
  assert.equal(specificStart.step, "START_ID");
  assert.equal(setRuleStartId(specificStart, "not-a-number").error, "Message ID must be a positive number.");
  const withMessageId = setRuleStartId(specificStart, "123");
  assert.equal(withMessageId.flow?.step, "SCHEDULE");
  flow = withMessageId.flow!;
  flow = chooseRuleSchedule(flow, { type: "INTERVAL", minutes: 120 });
  assert.equal(flow.step, "ACTIVE");
  assert.deepEqual(toRuleInput(flow, true), {
    sourceChannelId: 11,
    targetChannelId: 22,
    startMode: "MESSAGE_ID",
    startValue: "123",
    schedule: { type: "INTERVAL", minutes: 120 },
    active: true,
  });
  assert.equal(toRuleInput(beginRuleFlow(), true), undefined);

  const fixedStart = chooseRuleStart(chooseRuleTarget(chooseRuleSource(beginRuleFlow(), 11), 22), "LATEST");
  assert.equal(fixedStart.step, "SCHEDULE");
  const fixed = setFixedRuleSchedule(fixedStart, "10:00, invalid, 22:30");
  assert.deepEqual(fixed.flow?.schedule, {
    type: "FIXED",
    times: ["10:00", "22:30"],
  });
  assert.equal(fixed.flow?.step, "ACTIVE");
  assert.equal(setFixedRuleSchedule(fixedStart, "invalid").error, "Use 24-hour times like 10:00, 16:00, 22:00.");
});