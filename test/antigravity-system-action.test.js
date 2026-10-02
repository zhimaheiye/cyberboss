const test = require("node:test");
const assert = require("node:assert/strict");

const { mapAntigravityMessageToRuntimeEvents } = require("../src/adapters/runtime/antigravity/events");
const { StreamDelivery } = require("../src/core/stream-delivery");
const { CyberbossApp } = require("../src/core/app");

test("14. runtime returns response={\"action\":\"silent\"} without explicit status -> succeeds and suppresses reply", async () => {
  const convId = "conv-silent-test";
  const rawInit = { event: "init", conversation_id: convId };
  const rawResult = {
    event: "result",
    result: {
      conversation_id: convId,
      response: '{"action":"silent"}',
      num_turns: 1,
      usage: { total_tokens: 20 },
    },
  };

  // 1. Check mapped runtime events: must map to success events
  const initEvents = mapAntigravityMessageToRuntimeEvents(rawInit, { turnId: "turn-1", fallbackThreadId: convId });
  assert.equal(initEvents.length, 1);
  assert.equal(initEvents[0].type, "runtime.turn.started");

  const resultEvents = mapAntigravityMessageToRuntimeEvents(rawResult, { turnId: "turn-1", fallbackThreadId: convId });
  assert.equal(resultEvents.some((e) => e.type === "runtime.turn.failed"), false, "Must NOT emit runtime.turn.failed");
  assert.ok(resultEvents.some((e) => e.type === "runtime.reply.completed"), "Must emit runtime.reply.completed");
  assert.ok(resultEvents.some((e) => e.type === "runtime.turn.completed"), "Must emit runtime.turn.completed");

  // 2. Feed into StreamDelivery: action=silent must be suppressed and NOT sent to WeChat
  const sentTexts = [];
  const channelAdapter = {
    async sendText(payload) {
      sentTexts.push(payload);
    },
    getKnownContextTokens() {
      return {};
    },
  };
  const sessionStore = {
    findBindingForThreadId() {
      return {
        bindingKey: "b-1",
        account: { accountId: "acc-1" },
      };
    },
  };
  const streamDelivery = new StreamDelivery({ channelAdapter, sessionStore, runtimeId: "antigravity" });

  streamDelivery.queueReplyTargetForThread(convId, {
    accountId: "acc-1",
    userId: "user-1",
    contextToken: "ctx-token",
    source: "checkin",
  });

  for (const evt of [...initEvents, ...resultEvents]) {
    await streamDelivery.handleRuntimeEvent(evt);
  }

  assert.equal(sentTexts.length, 0, "WeChat must NOT receive any message when action=silent");

  // 3. Dispatch in CyberbossApp: must resolve true and not warn checkin failure or drop
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    let threadAttached = false;
    const appLike = {
      turnGateStore: {
        begin: () => "scope-silent",
        releaseScope: () => {},
        attachThread: () => { threadAttached = true; },
      },
      channelAdapter: {
        sendTyping: async () => {},
        sendText: async (payload) => { sentTexts.push(payload); },
      },
      runtimeAdapter: {
        getSessionStore: () => ({
          getRuntimeParamsForWorkspace: () => ({ model: "" }),
        }),
        describe: () => ({ id: "antigravity" }),
        sendTurn: async () => ({
          threadId: convId,
          turnId: "turn-1",
          status: "SUCCESS",
          response: '{"action":"silent"}',
        }),
      },
      buildRuntimeTurn: async () => ({ text: "checkin prompt", attachments: [] }),
      streamDelivery,
    };

    const prepared = {
      workspaceId: "default",
      accountId: "acc-1",
      senderId: "user-1",
      contextToken: "ctx-token",
      source: "checkin",
      text: "checkin prompt",
    };

    const dispatched = await CyberbossApp.prototype.dispatchPreparedTurn.call(appLike, {
      bindingKey: "b-1",
      workspaceRoot: "d:\\cyberboss",
      prepared,
    });

    assert.equal(dispatched, true, "dispatchPreparedTurn must return true on completed silent action");
    assert.equal(threadAttached, true, "TurnGateStore must attach thread on success");
    assert.equal(
      warnings.some((w) => w.includes("checkin runtime failed")),
      false,
      "Must not log checkin runtime failed warning"
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("15. runtime returns response={\"action\":\"send_message\",\"message\":\"测试\"} without explicit status -> delivers message to WeChat user", async () => {
  const convId = "conv-send-test";
  const rawInit = { event: "init", conversation_id: convId };
  const rawResult = {
    event: "result",
    result: {
      conversation_id: convId,
      response: '{"action":"send_message","message":"醒啦？今天这一觉睡得挺沉"}',
      num_turns: 1,
      usage: { total_tokens: 35 },
    },
  };

  // 1. Check mapped runtime events: must map to success events
  const initEvents = mapAntigravityMessageToRuntimeEvents(rawInit, { turnId: "turn-2", fallbackThreadId: convId });
  const resultEvents = mapAntigravityMessageToRuntimeEvents(rawResult, { turnId: "turn-2", fallbackThreadId: convId });

  assert.equal(resultEvents.some((e) => e.type === "runtime.turn.failed"), false, "Must NOT emit runtime.turn.failed");
  assert.ok(resultEvents.some((e) => e.type === "runtime.reply.completed"), "Must emit runtime.reply.completed");
  assert.ok(resultEvents.some((e) => e.type === "runtime.turn.completed"), "Must emit runtime.turn.completed");

  // 2. Feed into StreamDelivery: action=send_message must deliver extracted text to WeChat
  const sentTexts = [];
  const channelAdapter = {
    async sendText(payload) {
      sentTexts.push(payload);
    },
    getKnownContextTokens() {
      return {};
    },
  };
  const sessionStore = {
    findBindingForThreadId() {
      return {
        bindingKey: "b-1",
        account: { accountId: "acc-1" },
      };
    },
  };
  const streamDelivery = new StreamDelivery({ channelAdapter, sessionStore, runtimeId: "antigravity" });

  streamDelivery.queueReplyTargetForThread(convId, {
    accountId: "acc-1",
    userId: "user-1",
    contextToken: "ctx-token",
    source: "checkin",
  });

  for (const evt of [...initEvents, ...resultEvents]) {
    await streamDelivery.handleRuntimeEvent(evt);
  }

  assert.equal(sentTexts.length, 1, "WeChat must receive exactly one message for send_message action");
  assert.equal(sentTexts[0].userId, "user-1");
  assert.equal(sentTexts[0].text, "醒啦？今天这一觉睡得挺沉");

  // 3. Dispatch in CyberbossApp: must resolve true
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    let threadAttached = false;
    const appLike = {
      turnGateStore: {
        begin: () => "scope-send",
        releaseScope: () => {},
        attachThread: () => { threadAttached = true; },
      },
      channelAdapter: {
        sendTyping: async () => {},
        sendText: async (payload) => { sentTexts.push(payload); },
      },
      runtimeAdapter: {
        getSessionStore: () => ({
          getRuntimeParamsForWorkspace: () => ({ model: "" }),
        }),
        describe: () => ({ id: "antigravity" }),
        sendTurn: async () => ({
          threadId: convId,
          turnId: "turn-2",
          status: "SUCCESS",
          response: '{"action":"send_message","message":"醒啦？今天这一觉睡得挺沉"}',
        }),
      },
      buildRuntimeTurn: async () => ({ text: "checkin prompt", attachments: [] }),
      streamDelivery,
    };

    const prepared = {
      workspaceId: "default",
      accountId: "acc-1",
      senderId: "user-1",
      contextToken: "ctx-token",
      source: "checkin",
      text: "checkin prompt",
    };

    const dispatched = await CyberbossApp.prototype.dispatchPreparedTurn.call(appLike, {
      bindingKey: "b-1",
      workspaceRoot: "d:\\cyberboss",
      prepared,
    });

    assert.equal(dispatched, true, "dispatchPreparedTurn must return true on completed send_message action");
    assert.equal(threadAttached, true, "TurnGateStore must attach thread on success");
    assert.equal(
      warnings.some((w) => w.includes("checkin runtime failed")),
      false,
      "Must not log checkin runtime failed warning"
    );
  } finally {
    console.warn = originalWarn;
  }
});