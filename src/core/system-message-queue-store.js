const fs = require("fs");
const path = require("path");

class SystemMessageQueueStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { messages: [] };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      this.state = {
        messages: messages
          .map(normalizeSystemMessage)
          .filter(Boolean)
          .sort(compareSystemMessages),
      };
    } catch {
      this.state = { messages: [] };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  enqueue(message) {
    this.load();
    const normalized = normalizeSystemMessage(message);
    if (!normalized) {
      throw new Error("invalid system message");
    }
    this.state.messages.push(normalized);
    this.state.messages.sort(compareSystemMessages);
    this.save();
    return normalized;
  }

  drainDueForAccount(accountId, now = Date.now()) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    const nowMs = normalizeTimestampMs(now);
    const drained = [];
    const pending = [];

    for (const message of this.state.messages) {
      if (message.accountId === normalizedAccountId && isMessageDue(message, nowMs)) {
        drained.push(message);
      } else {
        pending.push(message);
      }
    }

    if (drained.length) {
      this.state.messages = pending;
      this.save();
    }

    return drained;
  }

  drainForAccount(accountId, now = Date.now()) {
    return this.drainDueForAccount(accountId, now);
  }

  hasPendingForAccount(accountId) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    return this.state.messages.some((message) => message.accountId === normalizedAccountId);
  }

  hasDueForAccount(accountId, now = Date.now()) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    const nowMs = normalizeTimestampMs(now);
    return this.state.messages.some((message) => message.accountId === normalizedAccountId && isMessageDue(message, nowMs));
  }
}

function normalizeSystemMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const id = normalizeText(message.id);
  const accountId = normalizeText(message.accountId);
  const senderId = normalizeText(message.senderId);
  const workspaceRoot = normalizeText(message.workspaceRoot);
  const text = normalizeText(message.text);
  const createdAt = normalizeIsoTime(message.createdAt);

  if (!id || !accountId || !senderId || !workspaceRoot || !text) {
    return null;
  }

  const source = normalizeText(message.source) === "checkin" ? "checkin" : "system";
  const attempts = Number.isInteger(message.attempts) && message.attempts >= 0 ? message.attempts : 0;
  const nextAttemptAt = normalizeIsoTime(message.nextAttemptAt) || "";

  return {
    id,
    accountId,
    senderId,
    workspaceRoot,
    text,
    createdAt: createdAt || new Date().toISOString(),
    source,
    attempts,
    nextAttemptAt,
  };
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

function compareSystemMessages(left, right) {
  const leftTime = Date.parse(left?.createdAt || "") || 0;
  const rightTime = Date.parse(right?.createdAt || "") || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isMessageDue(message, nowMs) {
  if (!message || typeof message !== "object") {
    return false;
  }
  const nextAttemptAt = normalizeText(message.nextAttemptAt);
  if (!nextAttemptAt) {
    return true;
  }
  const dueMs = Date.parse(nextAttemptAt);
  if (!Number.isFinite(dueMs)) {
    return true;
  }
  return dueMs <= nowMs;
}

function normalizeTimestampMs(now) {
  if (typeof now === "number" && Number.isFinite(now)) {
    return now;
  }
  if (typeof now === "string") {
    const parsed = Date.parse(now);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (now instanceof Date && !Number.isNaN(now.getTime())) {
    return now.getTime();
  }
  return Date.now();
}

module.exports = {
  SystemMessageQueueStore,
  normalizeSystemMessage,
  isMessageDue,
};
