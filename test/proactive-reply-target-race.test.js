const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { CyberbossApp } = require("../src/core/app");
const { readConfig } = require("../src/core/config");
const { SessionStore } = require("../src/adapters/runtime/codex/session-store");

function createTempDir(prefix = "cyberboss-race-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanTempDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {}
}

test("proactive replyTarget race: sendTurn emits completed before resolve still delivers message", async () => {
  const tempDir = createTempDir();
  const sessionsFile = path.join(tempDir, "sessions.json");
  const accountsDir = path.join(tempDir, "accounts");
  fs.mkdirSync(accountsDir, { recursive: true });

  const accountId = "test-account";
  const userId = "user-wechat-1@im.wechat";
  const contextToken = "valid-token-123";

  fs.writeFileSync(
    path.join(accountsDir, `${accountId}.context-tokens.json`),
    JSON.stringify({ [userId]: contextToken }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(accountsDir, `${accountId}.json`),
    JSON.stringify({ accountId, userId, token: "tok", baseUrl: "http://localhost" }),
    "utf8"
  );

  const sessionStore = new SessionStore({ filePath: sessionsFile, runtimeId: "antigravity" });
  const bindingKey = sessionStore.buildBindingKey({
    workspaceId: "default",
    accountId,
    senderId: userId,
  });
  sessionStore.setThreadIdForWorkspace(bindingKey, tempDir, "thread-proactive-1", {
    workspaceId: "default",
    accountId,
    senderId: userId,
  });

  const sentTexts = [];
  const channelAdapter = {
    describe() { return { id: "weixin", kind: "channel" }; },
    resolveAccount() { return { accountId, userId }; },
    getKnownContextTokens() { return { [userId]: contextToken }; },
    loadSyncBuffer() { return ""; },
    saveSyncBuffer() {},
    normalizeIncomingMessage(msg) { return msg; },
    async sendTyping() {},
    async sendText(payload) {
      sentTexts.push(payload);
    },
  };

  const baseConfig = readConfig();
  const app = new CyberbossApp({
    ...baseConfig,
    stateDir: tempDir,
    accountsDir,
    sessionsFile,
    projectToolContextFile: path.join(tempDir, "project-tool-runtime-context.json"),
    systemMessageQueueFile: path.join(tempDir, "system-messages.json"),
    deferredSystemReplyQueueFile: path.join(tempDir, "deferred-replies.json"),
    checkinConfigFile: path.join(tempDir, "checkin-config.json"),
    timelineScreenshotQueueFile: path.join(tempDir, "timeline-screenshots.json"),
    reminderQueueFile: path.join(tempDir, "reminders.json"),
    whereaboutsFile: path.join(tempDir, "whereabouts.json"),
    runtime: "antigravity",
    workspaceRoot: tempDir,
    allowedUserIds: [userId],
  });

  app.channelAdapter = channelAdapter;
  app.streamDelivery.channelAdapter = channelAdapter;
  app.streamDelivery.sessionStore = sessionStore;
  app.runtimeAdapter.getSessionStore = () => sessionStore;

  // SIMULATE ANTIGRAVITY RACE:
  // Antigravity CLI emits terminal event before sendTurn resolves
  app.runtimeAdapter.sendTurn = async () => {
    const threadId = "thread-proactive-1";
    const turnId = "turn-proactive-1";

    await app.handleRuntimeEvent({
      type: "runtime.turn.started",
      payload: { threadId, turnId },
    });
    await app.handleRuntimeEvent({
      type: "runtime.turn.completed",
      payload: {
        threadId,
        turnId,
        text: JSON.stringify({
          action: "send_message",
          message: "电脑忙完啦？又上如鸢清日常啦？",
        }),
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    return { threadId, turnId };
  };
  app.runtimeAdapter.sendTextTurn = app.runtimeAdapter.sendTurn;

  try {
    const dispatched = await app.dispatchPreparedTurn({
      bindingKey,
      workspaceRoot: tempDir,
      prepared: {
        provider: "system",
        workspaceId: "default",
        accountId,
        senderId: userId,
        text: "phone watch trigger",
        contextToken,
        source: "phone_watch",
      },
    });

    assert.equal(dispatched, true, "dispatchPreparedTurn should return true");
    assert.equal(sentTexts.length, 1, "channelAdapter.sendText must be called exactly once");
    assert.equal(sentTexts[0].userId, userId, "message must be sent to correct userId");
    assert.equal(sentTexts[0].text, "电脑忙完啦？又上如鸢清日常啦？", "sent text must match model message");
    assert.equal(sentTexts[0].contextToken, contextToken, "sent contextToken must match");
  } finally {
    cleanTempDir(tempDir);
  }
});

test("proactive replyTarget race: silent model result suppresses sendText cleanly", async () => {
  const tempDir = createTempDir();
  const sessionsFile = path.join(tempDir, "sessions.json");
  const accountsDir = path.join(tempDir, "accounts");
  fs.mkdirSync(accountsDir, { recursive: true });

  const accountId = "test-account";
  const userId = "user-wechat-1@im.wechat";
  const contextToken = "valid-token-123";

  fs.writeFileSync(
    path.join(accountsDir, `${accountId}.context-tokens.json`),
    JSON.stringify({ [userId]: contextToken }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(accountsDir, `${accountId}.json`),
    JSON.stringify({ accountId, userId, token: "tok", baseUrl: "http://localhost" }),
    "utf8"
  );

  const sessionStore = new SessionStore({ filePath: sessionsFile, runtimeId: "antigravity" });
  const bindingKey = sessionStore.buildBindingKey({
    workspaceId: "default",
    accountId,
    senderId: userId,
  });
  sessionStore.setThreadIdForWorkspace(bindingKey, tempDir, "thread-proactive-2", {
    workspaceId: "default",
    accountId,
    senderId: userId,
  });

  const sentTexts = [];
  const channelAdapter = {
    describe() { return { id: "weixin", kind: "channel" }; },
    resolveAccount() { return { accountId, userId }; },
    getKnownContextTokens() { return { [userId]: contextToken }; },
    loadSyncBuffer() { return ""; },
    saveSyncBuffer() {},
    normalizeIncomingMessage(msg) { return msg; },
    async sendTyping() {},
    async sendText(payload) {
      sentTexts.push(payload);
    },
  };

  const baseConfig = readConfig();
  const app = new CyberbossApp({
    ...baseConfig,
    stateDir: tempDir,
    accountsDir,
    sessionsFile,
    projectToolContextFile: path.join(tempDir, "project-tool-runtime-context.json"),
    systemMessageQueueFile: path.join(tempDir, "system-messages.json"),
    deferredSystemReplyQueueFile: path.join(tempDir, "deferred-replies.json"),
    checkinConfigFile: path.join(tempDir, "checkin-config.json"),
    timelineScreenshotQueueFile: path.join(tempDir, "timeline-screenshots.json"),
    reminderQueueFile: path.join(tempDir, "reminders.json"),
    whereaboutsFile: path.join(tempDir, "whereabouts.json"),
    runtime: "antigravity",
    workspaceRoot: tempDir,
    allowedUserIds: [userId],
  });

  app.channelAdapter = channelAdapter;
  app.streamDelivery.channelAdapter = channelAdapter;
  app.streamDelivery.sessionStore = sessionStore;
  app.runtimeAdapter.getSessionStore = () => sessionStore;

  app.runtimeAdapter.sendTurn = async () => {
    const threadId = "thread-proactive-2";
    const turnId = "turn-proactive-2";

    await app.handleRuntimeEvent({
      type: "runtime.turn.started",
      payload: { threadId, turnId },
    });
    await app.handleRuntimeEvent({
      type: "runtime.turn.completed",
      payload: {
        threadId,
        turnId,
        text: JSON.stringify({ action: "silent" }),
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    return { threadId, turnId };
  };
  app.runtimeAdapter.sendTextTurn = app.runtimeAdapter.sendTurn;

  try {
    const dispatched = await app.dispatchPreparedTurn({
      bindingKey,
      workspaceRoot: tempDir,
      prepared: {
        provider: "system",
        workspaceId: "default",
        accountId,
        senderId: userId,
        text: "phone watch trigger",
        contextToken,
        source: "phone_watch",
      },
    });

    assert.equal(dispatched, true, "dispatchPreparedTurn should return true");
    assert.equal(sentTexts.length, 0, "silent model action must not call sendText");
  } finally {
    cleanTempDir(tempDir);
  }
});
