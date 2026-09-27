import type { TelegramClient } from "telegram";

export type RuleSchedule =
  | { type: "INTERVAL"; minutes: number }
  | { type: "FIXED"; times: string[] };

export type RuleFlow = {
  kind: "RULE";
  step: "SOURCE" | "TARGET" | "POST_LINK" | "MESSAGE_COUNT" | "SCHEDULE" | "FIXED" | "ACTIVE";
  sourceChannelId?: number;
  targetChannelId?: number;
  startValue?: string;
  messageCount?: number;
  schedule?: RuleSchedule;
};

export type RuleInput = {
  sourceChannelId: number;
  targetChannelId: number;
  startValue: string;
  messageCount: number;
  schedule: RuleSchedule;
  active: boolean;
};

export function beginRuleFlow(): RuleFlow {
  return { kind: "RULE", step: "SOURCE" };
}

export function chooseRuleSource(flow: RuleFlow, sourceChannelId: number): RuleFlow {
  return { ...flow, sourceChannelId, step: "TARGET" };
}

export function chooseRuleTarget(flow: RuleFlow, targetChannelId: number): RuleFlow {
  return { ...flow, targetChannelId, step: "POST_LINK" };
}

/**
 * Telegram Post Link या Raw Message ID से ID निष्पादित करता है।
 * (Supports: https://t.me/c/12345/678, https://t.me/channelname/678, or raw '678')
 */
export function setRulePostLink(
  flow: RuleFlow,
  linkText: string,
): { flow?: RuleFlow; error?: string } {
  const trimmed = linkText.trim();
  
  // 1. Check if direct number ID was passed
  if (/^\d+$/.test(trimmed)) {
    return {
      flow: {
        ...flow,
        startValue: trimmed,
        step: "MESSAGE_COUNT",
      },
    };
  }

  // 2. Extract Message ID from URL format
  const match = trimmed.match(/\/(\d+)(?:\?|$)/);
  if (!match || !match[1]) {
    return { error: "Kripya ek valid Telegram post link bhejein (jaise: https://t.me/channel/123) ya Message ID likhein." };
  }

  return {
    flow: {
      ...flow,
      startValue: match[1],
      step: "MESSAGE_COUNT",
    },
  };
}

/**
 * Forward किए जाने वाले संदेशों की अधिकतम संख्या (Count Limit) सेट करता है।
 */
export function setRuleMessageCount(
  flow: RuleFlow,
  value: string,
): { flow?: RuleFlow; error?: string } {
  const count = Number(value.trim());
  if (!Number.isInteger(count) || count <= 0) {
    return { error: "Message count ek positive integer (number) hona chahiye." };
  }
  return {
    flow: {
      ...flow,
      messageCount: count,
      step: "SCHEDULE",
    },
  };
}

export function chooseRuleSchedule(flow: RuleFlow, schedule: RuleSchedule): RuleFlow {
  return { ...flow, schedule, step: "ACTIVE" };
}

export function setFixedRuleSchedule(
  flow: RuleFlow,
  value: string,
): { flow?: RuleFlow; error?: string } {
  const times = value
    .split(",")
    .map((time) => time.trim())
    .filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time));
  if (times.length === 0) {
    return { error: "Use 24-hour times like 10:00, 16:00, 22:00." };
  }
  return { flow: { ...flow, schedule: { type: "FIXED", times }, step: "ACTIVE" } };
}

export function toRuleInput(flow: RuleFlow, active: boolean): RuleInput | undefined {
  if (
    flow.sourceChannelId === undefined ||
    flow.targetChannelId === undefined ||
    !flow.startValue ||
    flow.messageCount === undefined ||
    !flow.schedule
  ) {
    return undefined;
  }
  return {
    sourceChannelId: flow.sourceChannelId,
    targetChannelId: flow.targetChannelId,
    startValue: flow.startValue,
    messageCount: flow.messageCount,
    schedule: flow.schedule,
    active,
  };
}