const SYSTEM_MESSAGE_RETRY_BACKOFF_MS = {
  1: 60_000,    // retry #1: at least 1 minute
  2: 300_000,   // retry #2: at least 5 minutes
  3: 900_000,   // retry #3: at least 15 minutes
};

const MAX_SYSTEM_MESSAGE_RETRIES = 3;

class SystemMessageDispatcher {
  constructor({ queueStore, config, accountId, clock = () => Date.now() }) {
    this.queueStore = queueStore;
    this.config = config;
    this.accountId = accountId;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
  }

  hasPending() {
    return this.hasDue();
  }

  hasDue(now = this.clock()) {
    if (typeof this.queueStore?.hasDueForAccount === "function") {
      return this.queueStore.hasDueForAccount(this.accountId, now);
    }
    return this.queueStore?.hasPendingForAccount(this.accountId) || false;
  }

  drainPending(now = this.clock()) {
    if (typeof this.queueStore?.drainDueForAccount === "function") {
      return this.queueStore.drainDueForAccount(this.accountId, now);
    }
    return this.queueStore?.drainForAccount(this.accountId) || [];
  }

  requeue(message) {
    if (!message || typeof message !== "object") {
      return null;
    }

    if (message.source === "checkin") {
      console.log(`[cyberboss] checkin system message failed; dropped id=${message.id}`);
      return null;
    }

    const currentAttempts = Number.isInteger(message.attempts) && message.attempts >= 0 ? message.attempts : 0;
    const newAttempts = currentAttempts + 1;

    if (newAttempts > MAX_SYSTEM_MESSAGE_RETRIES) {
      console.log(`[cyberboss] system message retries exhausted (${currentAttempts} retries); dropped id=${message.id}`);
      return null;
    }

    const backoffMs = SYSTEM_MESSAGE_RETRY_BACKOFF_MS[newAttempts] || 900_000;
    const nowMs = typeof this.clock === "function" ? this.clock() : Date.now();
    const nextAttemptAt = new Date(nowMs + backoffMs).toISOString();
    const delayMinutes = Math.round(backoffMs / 60_000);

    console.log(`[cyberboss] system message failed; scheduled retry #${newAttempts} in ${delayMinutes}m for id=${message.id}`);
    return this.queueStore.enqueue({
      ...message,
      attempts: newAttempts,
      nextAttemptAt,
    });
  }

  resolveWorkspaceRoot(message) {
    return normalizeText(message?.workspaceRoot) || normalizeText(this.config.workspaceRoot);
  }

  buildPreparedMessage(message, contextToken = "") {
    return {
      provider: "system",
      workspaceId: this.config.workspaceId,
      accountId: this.accountId,
      chatId: message.senderId,
      threadKey: `system:${message.senderId}`,
      senderId: message.senderId,
      messageId: message.id,
      text: buildSystemInboundText(message?.text, message?.createdAt),
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
      source: normalizeText(message?.source) === "checkin" ? "checkin" : "system",
    };
  }
}

function buildSystemInboundText(text, createdAt = "") {
  const body = normalizeText(text);
  const localTime = formatSystemLocalTime(createdAt);
  const sections = [
    ...(localTime ? [`[${localTime}]`, ""] : []),
    "SYSTEM ACTION MODE: internal trigger, not user chat.",
    "Do any timeline/diary/reminder/whereabouts work in this turn.",
    "If you act, end with send_message that briefly and naturally reflects what you did or what changed; use silent only if you do nothing.",
    "Return exactly one JSON object after any tool calls:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
    "No markdown fences. No reasoning. No text outside the JSON.",
  ];
  if (body) {
    sections.push("", "Trigger:", body);
  }
  return sections.join("\n").trim();
}

function formatSystemLocalTime(value) {
  const normalized = normalizeIsoTime(value);
  if (!normalized) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(normalized)).replace(/\//g, "-");
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  SystemMessageDispatcher,
  SYSTEM_MESSAGE_RETRY_BACKOFF_MS,
  MAX_SYSTEM_MESSAGE_RETRIES,
};
