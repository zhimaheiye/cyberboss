const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { CyberbossApp } = require("../src/core/app");
const { TurnGateStore } = require("../src/core/turn-gate-store");
const { readConfig } = require("../src/core/config");

function createAppFixture({
  runtimeSendTurn = null,
  runtimeAdapterOverride = null,
  bindingKey = "default:bot-1:user-1@im.wechat",
  workspaceRoot = "d:\\cyberboss",
  threadId = "thread-1",
} = {}) {
  const sentTexts = [];
  const eventListeners = new Set();
  const sessionThreadMap = new Map([[workspaceRoot, threadId]]);

  const mockSessionStore = {
    getThreadIdForWorkspace(bk, ws) {
      return sessionThreadMap.get(ws) || "";
    },
    setThreadIdForWorkspace(bk, ws, tid) {
      sessionThreadMap.set(ws, tid);
    },
    getRuntimeParamsForWorkspace() {
      return { model: "" };
    },
    findBindingForThreadId(tid) {
      if (tid === threadId || tid === sessionThreadMap.get(workspaceRoot)) {
        return { bindingKey, workspaceRoot };
      }
      return null;
    },
    getBinding() {
      return { accountId: "bot-1", senderId: "user-1@im.wechat" };
    },
    clearApprovalPrompt() {},
  };

  const mockRuntimeAdapter = runtimeAdapterOverride || {
    describe() {
      return { id: "antigravity", kind: "runtime" };
    },
    getSessionStore() {
      return mockSessionStore;
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    async sendTurn(args) {
      if (typeof runtimeSendTurn === "function") {
        return runtimeSendTurn(args, (event) => {
          for (const l of eventListeners) l(event);
        });
      }
      return { threadId, turnId: "turn-1" };
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
  };

  const channelAdapter = {
    async sendTyping() {},
    async sendText(payload) {
      sentTexts.push(payload);
    },
    getKnownContextTokens() {
      return { "user-1@im.wechat": "ctx-1" };
    },
  };

  const baseConfig = readConfig();
  const testStateDir = path.join(os.tmpdir(), "cyberboss-test-dedup-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(testStateDir, { recursive: true });

  const fullConfig = {
    ...baseConfig,
    stateDir: testStateDir,
    sessionsFile: path.join(testStateDir, "sessions.json"),
    projectToolContextFile: path.join(testStateDir, "project-tool-runtime-context.json"),
    workspaceRoot,
  };

  const app = new CyberbossApp(fullConfig);
  app.channelAdapter = channelAdapter;
  app.runtimeAdapter = mockRuntimeAdapter;
  app.activeDispatchByScopeKey = new Map();
  app.turnGateStore = new TurnGateStore();
  app.turnBoundaryScopeKeys = new Set();
  app.pendingOperationByRunKey = new Map();
  app.runtimeEventChain = Promise.resolve();

  mockRuntimeAdapter.onEvent((event) => {
    app.threadStateStore.applyRuntimeEvent(event);
    app.runtimeEventChain = app.runtimeEventChain
      .catch(() => {})
      .then(() => app.handleRuntimeEvent(event))
      .catch((error) => {
        console.error("runtime event error in test fixture:", error);
      });
  });

  return {
    app,
    sentTexts,
    emitEvent(evt) {
      for (const l of eventListeners) l(evt);
    },
    bindingKey,
    workspaceRoot,
    threadId,
  };
}

test("1. runtime emit runtime.turn.failed then sendTurn throw -> channel user receives only 1 failure", async () => {
  const { app, sentTexts, bindingKey, workspaceRoot, threadId } = createAppFixture({
    runtimeSendTurn: async (args, emit) => {
      emit({
        type: "runtime.turn.failed",
        payload: {
          threadId,
          turnId: "turn-fail-1",
          text: "antigravity turn failed with status ERROR: The stream was interrupted. Please continue the task you were working on.",
        },
      });
      throw new Error("antigravity turn failed with status ERROR: The stream was interrupted. Please continue the task you were working on.");
    },
  });

  const prepared = {
    workspaceId: "default",
    accountId: "bot-1",
    senderId: "user-1@im.wechat",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "hello test 1",
  };

  const result = await app.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  assert.equal(result, false);

  await app.runtimeEventChain;

  assert.equal(sentTexts.length, 1, `Expected exactly 1 failure message sent to WeChat, got ${sentTexts.length}: ${JSON.stringify(sentTexts)}`);
  assert.match(sentTexts[0].text, /The stream was interrupted/);
  assert.doesNotMatch(sentTexts[0].text, /Request failed/);
});

test("2. sendTurn directly throw and NO runtime.turn.failed event -> fallback Request failed still sent once", async () => {
  const { app, sentTexts, bindingKey, workspaceRoot } = createAppFixture({
    runtimeSendTurn: async () => {
      throw new Error("spawn claude ENOENT");
    },
  });

  const prepared = {
    workspaceId: "default",
    accountId: "bot-1",
    senderId: "user-1@im.wechat",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "hello test 2",
  };

  const result = await app.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  assert.equal(result, false);

  await app.runtimeEventChain;

  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0].text, /Request failed/);
  assert.match(sentTexts[0].text, /spawn claude ENOENT/);
});

test("3. normal success -> no error sent", async () => {
  const { app, sentTexts, bindingKey, workspaceRoot, threadId } = createAppFixture({
    runtimeSendTurn: async (args, emit) => {
      emit({
        type: "runtime.turn.completed",
        payload: {
          threadId,
          turnId: "turn-ok-1",
        },
      });
      return { threadId, turnId: "turn-ok-1" };
    },
  });

  const prepared = {
    workspaceId: "default",
    accountId: "bot-1",
    senderId: "user-1@im.wechat",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "hello success",
  };

  const result = await app.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  assert.equal(result, true);

  await app.runtimeEventChain;

  const errorMessages = sentTexts.filter((msg) => /failed/i.test(msg.text));
  assert.equal(errorMessages.length, 0);
});

test("4. checkin failure -> does NOT send error to WeChat", async () => {
  const { app, sentTexts, bindingKey, workspaceRoot, threadId } = createAppFixture({
    runtimeSendTurn: async (args, emit) => {
      emit({
        type: "runtime.turn.failed",
        payload: {
          threadId,
          turnId: "turn-checkin-fail",
          text: "The stream was interrupted.",
        },
      });
      throw new Error("The stream was interrupted.");
    },
  });

  const prepared = {
    workspaceId: "default",
    accountId: "bot-1",
    senderId: "user-1@im.wechat",
    contextToken: "ctx-1",
    provider: "system",
    source: "checkin",
    text: "checkin trigger",
  };

  const result = await app.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  assert.equal(result, false);

  await app.runtimeEventChain;

  assert.equal(sentTexts.length, 0, `Expected 0 messages sent to WeChat for checkin failure, got: ${JSON.stringify(sentTexts)}`);
});

test("5. STREAM_INTERRUPTED retry twice final failure -> user sees only 1 final error", async () => {
  let attempt = 0;
  const { app, sentTexts, bindingKey, workspaceRoot, threadId } = createAppFixture({
    runtimeSendTurn: async (args, emit) => {
      attempt += 1;
      attempt += 1;
      emit({
        type: "runtime.turn.failed",
        payload: {
          threadId,
          turnId: "turn-retry-exhausted",
          text: "antigravity turn failed with status ERROR: The stream was interrupted. Please continue the task you were working on.",
        },
      });
      throw new Error("antigravity turn failed with status ERROR: The stream was interrupted. Please continue the task you were working on.");
    },
  });

  const prepared = {
    workspaceId: "default",
    accountId: "bot-1",
    senderId: "user-1@im.wechat",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "hello retry test",
  };

  const result = await app.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  assert.equal(result, false);

  await app.runtimeEventChain;

  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0].text, /The stream was interrupted/);
  assert.doesNotMatch(sentTexts[0].text, /Request failed/);
});

test("6. STREAM_INTERRUPTED retry then success -> user sees NO transient error", async () => {
  let attempt = 0;
  const { app, sentTexts, bindingKey, workspaceRoot, threadId } = createAppFixture({
    runtimeSendTurn: async (args, emit) => {
      attempt += 1;
      attempt += 1;
      emit({
        type: "runtime.turn.completed",
        payload: {
          threadId,
          turnId: "turn-retry-success",
        },
      });
      return { threadId, turnId: "turn-retry-success" };
    },
  });

  const prepared = {
    workspaceId: "default",
    accountId: "bot-1",
    senderId: "user-1@im.wechat",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "hello retry ok",
  };

  const result = await app.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  assert.equal(result, true);

  await app.runtimeEventChain;

  assert.equal(sentTexts.length, 0);
  assert.equal(attempt, 2);
});