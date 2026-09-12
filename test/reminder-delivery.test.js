const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("os");

const { StreamDelivery } = require("../src/core/stream-delivery");
const { SystemMessageDispatcher, buildSystemInboundText } = require("../src/core/system-message-dispatcher");
const { ReminderQueueStore } = require("../src/adapters/channel/weixin/reminder-queue-store");
const { CyberbossApp } = require("../src/core/app");
const { readConfig } = require("../src/core/config");

function createDeliveryHarness({ sendText, getKnownContextTokens, runtimeId = "" } = {}) {
  const sent = [];
  const channelAdapter = {
    async sendText(payload) {
      if (typeof sendText === "function") {
        await sendText(payload, sent);
        return;
      }
      sent.push(payload);
    },
    getKnownContextTokens() {
      if (typeof getKnownContextTokens === "function") {
        return getKnownContextTokens();
      }
      return {};
    },
  };

  const bindingByThreadId = new Map();
  const sessionStore = {
    findBindingForThreadId(threadId) {
      return bindingByThreadId.get(threadId) || null;
    },
  };

  const streamDelivery = new StreamDelivery({ channelAdapter, sessionStore, runtimeId });
  return { sent, streamDelivery, bindingByThreadId, channelAdapter };
}

async function runCompletedTurn(streamDelivery, { threadId, turnId, itemId, text }) {
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId, turnId },
  });
  if (itemId && text !== undefined) {
    await streamDelivery.handleRuntimeEvent({
      type: "runtime.reply.completed",
      payload: { threadId, turnId, itemId, text },
    });
  }
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId, turnId },
  });
}

test("1. user reminder prompt includes critical rules (sole delivery, no daemon, do not assume delivered)", () => {
  const prompt = buildSystemInboundText("Due reminder for the user: 11:49 去学习", "2026-09-12T03:49:00Z", {
    source: "reminder",
    origin: "user",
    deliveryRequired: true,
    reminderText: "11:49 去学习",
  });

  assert.ok(prompt.includes("CRITICAL REMINDER RULES:"), "prompt should have critical reminder rules header");
  assert.ok(
    prompt.includes("No background daemon, reminder poller, or other service has sent or will send this reminder text to the user."),
    "prompt must clarify no daemon sends reminders"
  );
  assert.ok(
    prompt.includes("This turn is the SOLE delivery step."),
    "prompt must state this turn is the sole delivery step"
  );
  assert.ok(
    prompt.includes("Do NOT assume the reminder was already delivered"),
    "prompt must forbid assuming reminder was already delivered"
  );
});

test("2. user reminder prompt includes final action requirement and silent strictly invalid", () => {
  const prompt = buildSystemInboundText("Due reminder for the user: 该准备去睡觉了", "2026-09-12T17:30:00Z", {
    source: "reminder",
    origin: "user",
    deliveryRequired: true,
    reminderText: "该准备去睡觉了",
  });

  assert.ok(
    prompt.includes("FINAL ACTION REQUIREMENT: You MUST finish with send_message to deliver the reminder to the user on WeChat."),
    "prompt must mandate finishing with send_message"
  );
  assert.ok(
    prompt.includes("The 'silent' action is STRICTLY INVALID for this reminder."),
    "prompt must declare silent strictly invalid"
  );
  assert.ok(
    prompt.includes("Diary, timeline, or whereabouts actions may be performed in this turn, but they CANNOT replace the user-facing WeChat message."),
    "prompt must explicitly state diary cannot replace WeChat message"
  );
});

test("3. user reminder turn with model send_message delivers message and does not trigger fallback", async () => {
  const { sent, streamDelivery } = createDeliveryHarness();
  streamDelivery.queueReplyTargetForThread("thread-rem-1", {
    userId: "user-1",
    contextToken: "ctx-1",
    provider: "system",
    source: "reminder",
    deliveryRequired: true,
    fallbackText: "该去学习啦",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-rem-1",
    turnId: "turn-1",
    itemId: "item-1",
    text: "{\"action\":\"send_message\",\"message\":\"到点啦，该去学习啦！\"}",
  });

  assert.equal(sent.length, 1, "exactly one message sent");
  assert.equal(sent[0].text, "到点啦，该去学习啦！");
  assert.equal(sent[0].userId, "user-1");
});

test("4. user reminder turn with model silent triggers fallback and delivers original text", async () => {
  const { sent, streamDelivery } = createDeliveryHarness();
  streamDelivery.queueReplyTargetForThread("thread-rem-2", {
    userId: "user-2",
    contextToken: "ctx-2",
    provider: "system",
    source: "reminder",
    deliveryRequired: true,
    fallbackText: "该去学习啦",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-rem-2",
    turnId: "turn-1",
    itemId: "item-1",
    text: "{\"action\":\"silent\"}",
  });

  assert.equal(sent.length, 1, "fallback triggered exactly once");
  assert.equal(sent[0].text, "该去学习啦", "fallback delivered original reminder text");
  assert.equal(sent[0].userId, "user-2");
});

test("5. user reminder turn with model malformed JSON / raw text triggers fallback and delivers original text", async () => {
  const { sent, streamDelivery } = createDeliveryHarness();
  streamDelivery.queueReplyTargetForThread("thread-rem-3", {
    userId: "user-3",
    contextToken: "ctx-3",
    provider: "system",
    source: "reminder",
    deliveryRequired: true,
    fallbackText: "11:49 去学习",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-rem-3",
    turnId: "turn-1",
    itemId: "item-1",
    text: "Malformed output without proper json fence or braces: ```something",
  });

  assert.equal(sent.length, 1, "fallback triggered on malformed reply");
  assert.equal(sent[0].text, "11:49 去学习");
});

test("6. user reminder turn with empty reply triggers fallback and delivers original text", async () => {
  const { sent, streamDelivery } = createDeliveryHarness();
  streamDelivery.queueReplyTargetForThread("thread-rem-4", {
    userId: "user-4",
    contextToken: "ctx-4",
    provider: "system",
    source: "reminder",
    deliveryRequired: true,
    fallbackText: "提醒我去睡觉",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-rem-4",
    turnId: "turn-1",
  });

  assert.equal(sent.length, 1, "fallback triggered on empty turn completion");
  assert.equal(sent[0].text, "提醒我去睡觉");
});

test("7. phone_watch silent is suppressed and does not trigger reminder fallback", async () => {
  const { sent, streamDelivery } = createDeliveryHarness();
  streamDelivery.queueReplyTargetForThread("thread-pw", {
    userId: "user-pw",
    contextToken: "ctx-pw",
    provider: "system",
    source: "phone_watch",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-pw",
    turnId: "turn-1",
    itemId: "item-1",
    text: "{\"action\":\"silent\"}",
  });

  assert.equal(sent.length, 0, "phone_watch silent must be suppressed");
});

test("8. checkin silent is suppressed and does not trigger reminder fallback", async () => {
  const { sent, streamDelivery } = createDeliveryHarness();
  streamDelivery.queueReplyTargetForThread("thread-ci", {
    userId: "user-ci",
    contextToken: "ctx-ci",
    provider: "system",
    source: "checkin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-ci",
    turnId: "turn-1",
    itemId: "item-1",
    text: "{\"action\":\"silent\"}",
  });

  assert.equal(sent.length, 0, "checkin silent must be suppressed");
});

test("9. internal reminder (origin=internal, deliveryRequired=false) allows silent and does not trigger fallback", async () => {
  const prompt = buildSystemInboundText("Due reminder for the user: internal sync note", "2026-09-12T03:49:00Z", {
    source: "reminder",
    origin: "internal",
    deliveryRequired: false,
    reminderText: "internal sync note",
  });

  assert.ok(
    !prompt.includes("STRICTLY INVALID"),
    "internal reminder prompt must not declare silent strictly invalid"
  );
  assert.ok(
    prompt.includes("This is an internal/proactive reminder"),
    "internal reminder prompt guides model that silent or diary is allowed"
  );

  const { sent, streamDelivery } = createDeliveryHarness();
  streamDelivery.queueReplyTargetForThread("thread-internal-rem", {
    userId: "user-internal",
    contextToken: "ctx-internal",
    provider: "system",
    source: "reminder",
    deliveryRequired: false,
    fallbackText: "internal sync note",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-internal-rem",
    turnId: "turn-1",
    itemId: "item-1",
    text: "{\"action\":\"silent\"}",
  });

  assert.equal(sent.length, 0, "internal reminder with deliveryRequired=false allows silent");
});

test("10. legacy reminder queue data without origin/deliveryRequired defaults to user and deliveryRequired=true", () => {
  const legacyEntry = {
    id: "legacy-1",
    accountId: "acc-1",
    senderId: "user-1",
    contextToken: "ctx-legacy",
    text: "喝水测试",
    dueAtMs: 1234567890,
    createdAt: "2026-09-12T00:00:00.000Z",
  };

  const normalized = ReminderQueueStore.normalizeReminder(legacyEntry);
  assert.equal(normalized.origin, "user", "legacy reminder defaults to origin=user");
  assert.equal(normalized.deliveryRequired, true, "legacy reminder defaults to deliveryRequired=true");

  const dispatcher = new SystemMessageDispatcher({
    queueStore: { hasPendingForAccount: () => false },
    config: { workspaceId: "ws-1", workspaceRoot: "/workspace" },
    accountId: "acc-1",
  });

  const prepared = dispatcher.buildPreparedMessage({
    id: "rem:legacy-1",
    senderId: "user-1",
    source: "reminder",
    reminderText: legacyEntry.text,
    createdAt: legacyEntry.createdAt,
    text: `Due reminder: ${legacyEntry.text}`,
  }, "ctx-token-1");

  assert.equal(prepared.source, "reminder");
  assert.equal(prepared.origin, "user");
  assert.equal(prepared.deliveryRequired, true);
  assert.equal(prepared.fallbackText, "喝水测试");
});

test("11. model in reminder turn performs diary/timeline then returns silent triggers fallback", async () => {
  const { sent, streamDelivery } = createDeliveryHarness();
  streamDelivery.queueReplyTargetForThread("thread-rem-diary", {
    userId: "user-11",
    contextToken: "ctx-11",
    provider: "system",
    source: "reminder",
    deliveryRequired: true,
    fallbackText: "提醒我去学习",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-rem-diary",
    turnId: "turn-diary",
    itemId: "item-diary",
    text: "```json\n{\"action\":\"silent\"}\n```",
  });

  assert.equal(sent.length, 1, "fallback triggered even after diary substitution attempted");
  assert.equal(sent[0].text, "提醒我去学习");
  assert.equal(sent[0].userId, "user-11");
});

test("12. no double send under any circumstances (model send_message vs fallback)", async () => {
  // Scenario A: Model returns valid send_message
  {
    const { sent, streamDelivery } = createDeliveryHarness();
    streamDelivery.queueReplyTargetForThread("thread-dedup-a", {
      userId: "user-a",
      contextToken: "ctx-a",
      provider: "system",
      source: "reminder",
      deliveryRequired: true,
      fallbackText: "测试提醒",
    });

    await runCompletedTurn(streamDelivery, {
      threadId: "thread-dedup-a",
      turnId: "turn-a",
      itemId: "item-a",
      text: "{\"action\":\"send_message\",\"message\":\"测试提醒来了\"}",
    });

    assert.equal(sent.length, 1, "only model message delivered");
    assert.equal(sent[0].text, "测试提醒来了");
  }

  // Scenario B: Model returns silent
  {
    const { sent, streamDelivery } = createDeliveryHarness();
    streamDelivery.queueReplyTargetForThread("thread-dedup-b", {
      userId: "user-b",
      contextToken: "ctx-b",
      provider: "system",
      source: "reminder",
      deliveryRequired: true,
      fallbackText: "测试提醒",
    });

    await runCompletedTurn(streamDelivery, {
      threadId: "thread-dedup-b",
      turnId: "turn-b",
      itemId: "item-b",
      text: "{\"action\":\"silent\"}",
    });

    assert.equal(sent.length, 1, "only fallback message delivered");
    assert.equal(sent[0].text, "测试提醒");
  }
});

test("13. CyberbossApp dispatchPreparedTurn catch and sendFailureToThread deliver fallbackText on failure", async () => {
  const sent = [];
  const fakeChannelAdapter = {
    sent,
    async sendText(payload) {
      sent.push(payload);
    },
    getKnownContextTokens() {
      return { "user-fail": "ctx-fail" };
    },
  };

  const fakeSessionStore = {
    findBindingForThreadId() {
      return { bindingKey: "b1", workspaceRoot: "/ws" };
    },
    getBinding() {
      return { senderId: "user-fail" };
    },
  };

  const baseConfig = readConfig();
  const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-test-rem-"));
  const app = new CyberbossApp({
    ...baseConfig,
    stateDir: testStateDir,
    sessionsFile: path.join(testStateDir, "sessions.json"),
    projectToolContextFile: path.join(testStateDir, "project-tool-runtime-context.json"),
    systemMessageQueueFile: path.join(testStateDir, "system-messages.json"),
    deferredSystemReplyQueueFile: path.join(testStateDir, "deferred-replies.json"),
    checkinConfigFile: path.join(testStateDir, "checkin-config.json"),
    timelineScreenshotQueueFile: path.join(testStateDir, "timeline-screenshots.json"),
    reminderQueueFile: path.join(testStateDir, "reminders.json"),
    whereaboutsFile: path.join(testStateDir, "whereabouts.json"),
    runtime: "antigravity",
    workspaceRoot: "/ws",
  });
  app.channelAdapter = fakeChannelAdapter;
  app.runtimeAdapter = {
    getSessionStore() {
      return fakeSessionStore;
    },
  };

  await app.sendFailureToThread("thread-fail-1", "runtime crashed", {
    userId: "user-fail",
    contextToken: "ctx-fail",
    source: "reminder",
    deliveryRequired: true,
    fallbackText: "1分钟后提醒我喝水",
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "1分钟后提醒我喝水", "sendFailureToThread delivers fallback reminder text instead of error");
});
