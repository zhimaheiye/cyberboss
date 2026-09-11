const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { PhoneActivityWatcher, buildPhoneWatchTriggerText } = require("../src/app/phone-activity-watcher");
const { PhoneWatchStateStore } = require("../src/core/phone-watch-state-store");
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");
const { SystemMessageDispatcher } = require("../src/core/system-message-dispatcher");
const { VegliaActivitySource } = require("../src/adapters/veglia/client");
const { CheckinConfigStore } = require("../src/core/checkin-config-store");

function createMockQueueStore() {
  const messages = [];
  return {
    messages,
    enqueue(msg) {
      messages.push({ ...msg });
      return { ...msg };
    },
    drainForAccount(accountId) {
      const matched = messages.filter((m) => m.accountId === accountId);
      messages.length = 0;
      return matched;
    },
    drainDueForAccount(accountId) {
      const matched = messages.filter((m) => m.accountId === accountId);
      messages.length = 0;
      return matched;
    },
    hasPendingForAccount(accountId) {
      return messages.some((m) => m.accountId === accountId);
    },
    hasDueForAccount(accountId) {
      return messages.some((m) => m.accountId === accountId);
    },
  };
}

function createMockActivitySource(initialResponse = { ok: true, events: [], mostRecent: null }) {
  let response = initialResponse;
  return {
    setResponse(r) {
      response = r;
    },
    async getActivity() {
      return response;
    },
  };
}

test("1. 手机 active 5min -> 不 trigger", async () => {
  let currentTime = 1_700_000_000_000;
  const clock = () => currentTime;
  const mockSource = createMockActivitySource();
  const queueStore = createMockQueueStore();
  const stateStore = new PhoneWatchStateStore({ filePath: "" });

  const watcher = new PhoneActivityWatcher({
    clock,
    activitySource: mockSource,
    stateStore,
    queueStore,
    target: { accountId: "acc-1", senderId: "user-1", workspaceRoot: "d:\\cyberboss" },
    triggerAfterMs: 10 * 60_000,
    triggerCooldownMs: 15 * 60_000,
  });

  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  const res1 = await watcher.sample();
  assert.equal(res1.triggered, false);
  assert.equal(queueStore.messages.length, 0);

  currentTime += 5 * 60_000;
  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime - 10_000, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime - 10_000, event: "switch" },
  });
  const res2 = await watcher.sample();
  assert.equal(res2.triggered, false);
  assert.equal(res2.reason, "below_threshold");
  assert.equal(queueStore.messages.length, 0);
});

test("2. 连续 active 10min+ -> enqueue 1 个 phone_watch", async () => {
  let currentTime = 1_700_000_000_000;
  const clock = () => currentTime;
  const mockSource = createMockActivitySource();
  const queueStore = createMockQueueStore();
  const stateStore = new PhoneWatchStateStore({ filePath: "" });

  const watcher = new PhoneActivityWatcher({
    clock,
    activitySource: mockSource,
    stateStore,
    queueStore,
    target: { accountId: "acc-1", senderId: "user-1", workspaceRoot: "d:\\cyberboss" },
    triggerAfterMs: 10 * 60_000,
    triggerCooldownMs: 15 * 60_000,
  });

  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  await watcher.sample();

  currentTime += 10 * 60_000;
  mockSource.setResponse({
    ok: true,
    events: [
      { app: "com.xingin.xhs", label: "小红书", ts: currentTime - 5 * 60_000, event: "switch" },
      { app: "com.tencent.mm", label: "微信", ts: currentTime - 30_000, event: "switch" },
    ],
    mostRecent: { app: "com.tencent.mm", label: "微信", ts: currentTime - 30_000, event: "switch" },
  });
  const res = await watcher.sample();
  assert.equal(res.triggered, true);
  assert.equal(queueStore.messages.length, 1);

  const queued = queueStore.messages[0];
  assert.equal(queued.source, "phone_watch");
  assert.equal(queued.accountId, "acc-1");
  assert.equal(queued.senderId, "user-1");
  assert.match(queued.text, /\[Phone activity awareness\]/);
  assert.match(queued.text, /Continuous active duration: about 10 minutes/);
  assert.match(queued.text, /Decide naturally whether to stay silent or send a message/);
});

test("3. 触发后 15min cooldown 内仍 active -> 不重复 enqueue", async () => {
  let currentTime = 1_700_000_000_000;
  const clock = () => currentTime;
  const mockSource = createMockActivitySource();
  const queueStore = createMockQueueStore();
  const stateStore = new PhoneWatchStateStore({ filePath: "" });

  const watcher = new PhoneActivityWatcher({
    clock,
    activitySource: mockSource,
    stateStore,
    queueStore,
    target: { accountId: "acc-1", senderId: "user-1", workspaceRoot: "d:\\cyberboss" },
    triggerAfterMs: 10 * 60_000,
    triggerCooldownMs: 15 * 60_000,
  });

  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  await watcher.sample();

  currentTime += 10 * 60_000;
  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  const res1 = await watcher.sample();
  assert.equal(res1.triggered, true);
  assert.equal(queueStore.messages.length, 1);

  currentTime += 5 * 60_000;
  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  const res2 = await watcher.sample();
  assert.equal(res2.triggered, false);
  assert.equal(res2.reason, "in_cooldown");
  assert.equal(queueStore.messages.length, 1);
});

test("4. cooldown 到期且仍持续 active -> 可以 enqueue 下一次", async () => {
  let currentTime = 1_700_000_000_000;
  const clock = () => currentTime;
  const mockSource = createMockActivitySource();
  const queueStore = createMockQueueStore();
  const stateStore = new PhoneWatchStateStore({ filePath: "" });

  const watcher = new PhoneActivityWatcher({
    clock,
    activitySource: mockSource,
    stateStore,
    queueStore,
    target: { accountId: "acc-1", senderId: "user-1", workspaceRoot: "d:\\cyberboss" },
    triggerAfterMs: 10 * 60_000,
    triggerCooldownMs: 15 * 60_000,
  });

  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  await watcher.sample();

  currentTime += 10 * 60_000;
  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  await watcher.sample();
  assert.equal(queueStore.messages.length, 1);

  currentTime += 15 * 60_000;
  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.tencent.mm", label: "微信", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.tencent.mm", label: "微信", ts: currentTime, event: "switch" },
  });
  const res = await watcher.sample();
  assert.equal(res.triggered, true);
  assert.equal(queueStore.messages.length, 2);
  assert.match(queueStore.messages[1].text, /Continuous active duration: about 25 minutes/);
  assert.match(queueStore.messages[1].text, /Last phone-watch trigger: 15 minutes ago/);
});

test("5. 手机 inactive 足够长 -> session reset", async () => {
  let currentTime = 1_700_000_000_000;
  const clock = () => currentTime;
  const mockSource = createMockActivitySource();
  const queueStore = createMockQueueStore();
  const stateStore = new PhoneWatchStateStore({ filePath: "" });

  const watcher = new PhoneActivityWatcher({
    clock,
    activitySource: mockSource,
    stateStore,
    queueStore,
    target: { accountId: "acc-1", senderId: "user-1", workspaceRoot: "d:\\cyberboss" },
    triggerAfterMs: 10 * 60_000,
    inactiveResetMs: 10 * 60_000,
  });

  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  await watcher.sample();
  assert.ok(stateStore.getState().sessionStartedAt);

  currentTime += 12 * 60_000;
  const res = await watcher.sample();
  assert.equal(res.triggered, false);
  assert.equal(res.reason, "inactive_timeout");

  const state = stateStore.getState();
  assert.equal(state.sessionStartedAt, null);
  assert.equal(state.continuousActiveMs, 0);
  assert.ok(state.lastResetAt);
});

test("6. reset 后重新 active -> 从 0 重新计算", async () => {
  let currentTime = 1_700_000_000_000;
  const clock = () => currentTime;
  const mockSource = createMockActivitySource();
  const queueStore = createMockQueueStore();
  const stateStore = new PhoneWatchStateStore({ filePath: "" });

  const watcher = new PhoneActivityWatcher({
    clock,
    activitySource: mockSource,
    stateStore,
    queueStore,
    target: { accountId: "acc-1", senderId: "user-1", workspaceRoot: "d:\\cyberboss" },
    triggerAfterMs: 10 * 60_000,
    inactiveResetMs: 10 * 60_000,
  });

  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  await watcher.sample();

  currentTime += 12 * 60_000;
  await watcher.sample();
  assert.equal(stateStore.getState().continuousActiveMs, 0);

  currentTime += 8 * 60_000;
  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.tencent.mm", label: "微信", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.tencent.mm", label: "微信", ts: currentTime, event: "switch" },
  });
  const res = await watcher.sample();
  assert.equal(res.triggered, false);
  assert.equal(stateStore.getState().continuousActiveMs, 0);
});

test("7. Veglia offline/unknown -> 不误判持续使用", async () => {
  let currentTime = 1_700_000_000_000;
  const clock = () => currentTime;
  const mockSource = createMockActivitySource({ ok: false, error: "ECONNREFUSED" });
  const queueStore = createMockQueueStore();
  const stateStore = new PhoneWatchStateStore({ filePath: "" });

  const watcher = new PhoneActivityWatcher({
    clock,
    activitySource: mockSource,
    stateStore,
    queueStore,
    target: { accountId: "acc-1", senderId: "user-1", workspaceRoot: "d:\\cyberboss" },
    triggerAfterMs: 10 * 60_000,
  });

  const res = await watcher.sample();
  assert.equal(res.triggered, false);
  assert.equal(res.reason, "offline");
  assert.equal(stateStore.getState().continuousActiveMs, 0);
  assert.equal(queueStore.messages.length, 0);
});

test("8. CyberBoss 重启 -> state file 能恢复 session / cooldown", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-test-pw-"));
  const stateFile = path.join(tmpDir, "phone-watch-state.json");

  try {
    let currentTime = 1_700_000_000_000;
    const clock = () => currentTime;
    const mockSource = createMockActivitySource();
    const queueStore = createMockQueueStore();

    const stateStore1 = new PhoneWatchStateStore({ filePath: stateFile });
    const watcher1 = new PhoneActivityWatcher({
      clock,
      activitySource: mockSource,
      stateStore: stateStore1,
      queueStore,
      target: { accountId: "acc-1", senderId: "user-1", workspaceRoot: "d:\\cyberboss" },
      triggerAfterMs: 10 * 60_000,
    });

    mockSource.setResponse({
      ok: true,
      events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
      mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
    });
    await watcher1.sample();

    currentTime += 10 * 60_000;
    mockSource.setResponse({
      ok: true,
      events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
      mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
    });
    await watcher1.sample();
    assert.equal(queueStore.messages.length, 1);

    currentTime += 2 * 60_000;
    const stateStore2 = new PhoneWatchStateStore({ filePath: stateFile });
    const watcher2 = new PhoneActivityWatcher({
      clock,
      activitySource: mockSource,
      stateStore: stateStore2,
      queueStore,
      target: { accountId: "acc-1", senderId: "user-1", workspaceRoot: "d:\\cyberboss" },
      triggerAfterMs: 10 * 60_000,
      triggerCooldownMs: 15 * 60_000,
    });

    const state2 = stateStore2.getState();
    assert.ok(state2.sessionStartedAt);
    assert.ok(state2.lastTriggerAt);
    assert.equal(state2.currentApp, "小红书");

    mockSource.setResponse({
      ok: true,
      events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
      mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
    });
    const res = await watcher2.sample();
    assert.equal(res.triggered, false);
    assert.equal(res.reason, "in_cooldown");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("9. phone_watch trigger 只 enqueue system message -> watcher 自己绝不 sendText", async () => {
  let currentTime = 1_700_000_000_000;
  const clock = () => currentTime;
  const mockSource = createMockActivitySource();
  const queueStore = createMockQueueStore();
  const stateStore = new PhoneWatchStateStore({ filePath: "" });

  const watcher = new PhoneActivityWatcher({
    clock,
    activitySource: mockSource,
    stateStore,
    queueStore,
    target: { accountId: "acc-1", senderId: "user-1", workspaceRoot: "d:\\cyberboss" },
    triggerAfterMs: 10 * 60_000,
  });

  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  await watcher.sample();

  currentTime += 10 * 60_000;
  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  const res = await watcher.sample();
  assert.equal(res.triggered, true);
  assert.equal(queueStore.messages.length, 1);
  assert.equal(queueStore.messages[0].source, "phone_watch");
  assert.equal(typeof watcher.channelAdapter, "undefined");
});

test("10. phone_watch runtime failure -> drop -> 不 requeue -> 不向微信发 error", async () => {
  const queueStore = createMockQueueStore();
  const dispatcher = new SystemMessageDispatcher({
    queueStore,
    accountId: "acc-1",
    config: { workspaceId: "ws-1", workspaceRoot: "d:\\cyberboss" },
  });

  const requeued = dispatcher.requeue({
    id: "pw-fail-1",
    accountId: "acc-1",
    senderId: "user-1",
    workspaceRoot: "d:\\cyberboss",
    text: "test",
    source: "phone_watch",
    attempts: 0,
  });

  assert.equal(requeued, null);
  assert.equal(queueStore.messages.length, 0);
});

test("11. 普通 reminder failure -> 原 bounded retry 不受影响", async () => {
  const queueStore = createMockQueueStore();
  const dispatcher = new SystemMessageDispatcher({
    queueStore,
    accountId: "acc-1",
    config: { workspaceId: "ws-1", workspaceRoot: "d:\\cyberboss" },
    clock: () => 1_700_000_000_000,
  });

  const requeued = dispatcher.requeue({
    id: "sys-msg-1",
    accountId: "acc-1",
    senderId: "user-1",
    workspaceRoot: "d:\\cyberboss",
    text: "Meeting reminder",
    source: "system",
    attempts: 0,
  });

  assert.ok(requeued);
  assert.equal(requeued.attempts, 1);
  assert.ok(requeued.nextAttemptAt);
  assert.equal(queueStore.messages.length, 1);
});

test("12. 普通 checkin -> 原行为不受影响", async () => {
  const queueStore = createMockQueueStore();
  const dispatcher = new SystemMessageDispatcher({
    queueStore,
    accountId: "acc-1",
    config: { workspaceId: "ws-1", workspaceRoot: "d:\\cyberboss" },
  });

  const requeued = dispatcher.requeue({
    id: "checkin-1",
    accountId: "acc-1",
    senderId: "user-1",
    workspaceRoot: "d:\\cyberboss",
    text: "User comes to mind again.",
    source: "checkin",
    attempts: 0,
  });
  assert.equal(requeued, null);
  assert.equal(queueStore.messages.length, 0);

  const prepared = dispatcher.buildPreparedMessage({
    id: "checkin-2",
    accountId: "acc-1",
    senderId: "user-1",
    workspaceRoot: "d:\\cyberboss",
    text: "User comes to mind again.",
    source: "checkin",
  });
  assert.equal(prepared.source, "checkin");
});

test("13. 采样 20 次但始终没达到 trigger 条件 -> AGY runtime 0 次调用", async () => {
  let currentTime = 1_700_000_000_000;
  const clock = () => currentTime;
  const mockSource = createMockActivitySource();
  const queueStore = createMockQueueStore();
  const stateStore = new PhoneWatchStateStore({ filePath: "" });

  const watcher = new PhoneActivityWatcher({
    clock,
    activitySource: mockSource,
    stateStore,
    queueStore,
    target: { accountId: "acc-1", senderId: "user-1", workspaceRoot: "d:\\cyberboss" },
    triggerAfterMs: 10 * 60_000,
    inactiveResetMs: 5 * 60_000,
  });

  for (let i = 0; i < 20; i += 1) {
    currentTime += 3 * 60_000;
    if (i % 2 === 0) {
      mockSource.setResponse({
        ok: true,
        events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
        mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
      });
    } else {
      mockSource.setResponse({
        ok: true,
        events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime - 10 * 60_000, event: "switch" }],
        mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime - 10 * 60_000, event: "switch" },
      });
    }
    await watcher.sample();
  }

  assert.equal(queueStore.messages.length, 0);
});

test("14. 连续活动达到条件 -> 只在 trigger 时产生 AGY runtime turn", async () => {
  let currentTime = 1_700_000_000_000;
  const clock = () => currentTime;
  const mockSource = createMockActivitySource();
  const queueStore = createMockQueueStore();
  const stateStore = new PhoneWatchStateStore({ filePath: "" });

  const watcher = new PhoneActivityWatcher({
    clock,
    activitySource: mockSource,
    stateStore,
    queueStore,
    target: { accountId: "acc-1", senderId: "user-1", workspaceRoot: "d:\\cyberboss" },
    triggerAfterMs: 10 * 60_000,
    triggerCooldownMs: 15 * 60_000,
  });

  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  await watcher.sample();
  assert.equal(queueStore.messages.length, 0);

  currentTime += 5 * 60_000;
  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  await watcher.sample();
  assert.equal(queueStore.messages.length, 0);

  currentTime += 5 * 60_000;
  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  await watcher.sample();
  assert.equal(queueStore.messages.length, 1);

  currentTime += 5 * 60_000;
  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  await watcher.sample();
  assert.equal(queueStore.messages.length, 1);
});
