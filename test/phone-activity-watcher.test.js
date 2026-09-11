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

// ============================================================================
// Section VII: Heartbeat & Continuous Phone Use Tests
// ============================================================================

test("15. Section VII.1: 20:00 switch 到小红书，40min 无 switch event 但 heartbeat 活跃 -> 10min 触发且不被判 inactive", async () => {
  let currentTime = 1_700_000_000_000;
  const t0 = currentTime;
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
    heartbeatStaleMs: 180_000,
  });

  // Events only has the initial switch to Xiaohongshu at 20:00
  const initialEvents = [
    { app: "com.xingin.xhs", label: "小红书", ts: t0, event: "switch" },
  ];

  // Sample at t0 (20:00)
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: currentTime },
    events: initialEvents,
  });
  const res0 = await watcher.sample();
  assert.equal(res0.triggered, false);

  // Sample at t0 + 5m (20:05) - no new switch events, but heartbeat is fresh (15s ago)
  currentTime = t0 + 5 * 60_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: currentTime - 15_000 },
    events: initialEvents,
  });
  const res5 = await watcher.sample();
  assert.equal(res5.triggered, false);
  assert.equal(res5.reason, "below_threshold");
  assert.equal(res5.continuousActiveMs, 5 * 60_000);

  // Sample at t0 + 10m (20:10) - still no switch events, heartbeat still fresh!
  currentTime = t0 + 10 * 60_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: currentTime - 20_000 },
    events: initialEvents,
  });
  const res10 = await watcher.sample();
  assert.equal(res10.triggered, true, "Must trigger at 10m despite no app switches");
  assert.equal(res10.continuousActiveMs, 10 * 60_000);
  assert.equal(res10.currentApp, "小红书");
  assert.equal(queueStore.messages.length, 1);

  // Sample at t0 + 15m (20:15) - still active, in cooldown
  currentTime = t0 + 15 * 60_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: currentTime - 10_000 },
    events: initialEvents,
  });
  const res15 = await watcher.sample();
  assert.equal(res15.triggered, false);
  assert.equal(res15.reason, "in_cooldown");

  // Sample at t0 + 25m (20:25) - cooldown elapsed (15m elapsed since 20:10), triggers again!
  currentTime = t0 + 25 * 60_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: currentTime - 10_000 },
    events: initialEvents,
  });
  const res25 = await watcher.sample();
  assert.equal(res25.triggered, true, "Must trigger again after cooldown elapsed");
  assert.equal(res25.continuousActiveMs, 25 * 60_000);
  assert.equal(queueStore.messages.length, 2);

  // Sample at t0 + 40m (20:40) - still active! Never marked inactive!
  currentTime = t0 + 40 * 60_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: currentTime - 10_000 },
    events: initialEvents,
  });
  const res40 = await watcher.sample();
  assert.equal(res40.continuousActiveMs, 40 * 60_000);
  assert.notEqual(res40.reason, "inactive_timeout");
});

test("16. Section VII.2: 5m sample 与 60s heartbeat 不对齐 -> 仍可靠在 10~15min 触发", async () => {
  let currentTime = 1_700_000_000_000;
  const t0 = currentTime;
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
    heartbeatStaleMs: 180_000,
  });

  // t0: sample 1, heartbeat at t0 - 17s
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: t0 - 17_000 },
    events: [],
  });
  await watcher.sample();

  // t0 + 300s (5m): sample 2, heartbeat at t0 + 273s (27s ago)
  currentTime = t0 + 300_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: t0 + 273_000 },
    events: [],
  });
  const res2 = await watcher.sample();
  assert.equal(res2.triggered, false);

  // t0 + 600s (10m): sample 3, heartbeat at t0 + 581s (19s ago)
  currentTime = t0 + 600_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: t0 + 581_000 },
    events: [],
  });
  const res3 = await watcher.sample();
  assert.equal(res3.triggered, true, "Must trigger at 10m regardless of heartbeat phase offset");
  assert.equal(queueStore.messages.length, 1);
});

test("17. Section VII.3: 小红书 -> 微信 -> B站，screen 一直 interactive -> 同一 continuous session", async () => {
  let currentTime = 1_700_000_000_000;
  const t0 = currentTime;
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

  // t0: Xiaohongshu
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", label: "小红书", screenInteractive: true, lastHeartbeatTs: t0 },
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: t0, event: "switch" }],
  });
  await watcher.sample();

  // t0 + 5m: Switched to WeChat
  currentTime = t0 + 5 * 60_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "com.tencent.mm", label: "微信", screenInteractive: true, lastHeartbeatTs: currentTime },
    events: [
      { app: "com.xingin.xhs", label: "小红书", ts: t0, event: "switch" },
      { app: "com.tencent.mm", label: "微信", ts: t0 + 3 * 60_000, event: "switch" },
    ],
  });
  const res2 = await watcher.sample();
  assert.equal(res2.continuousActiveMs, 5 * 60_000);
  assert.equal(stateStore.getState().currentApp, "微信");

  // t0 + 10m: Switched to Bilibili
  currentTime = t0 + 10 * 60_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "tv.danmaku.bili", label: "哔哩哔哩", screenInteractive: true, lastHeartbeatTs: currentTime },
    events: [
      { app: "com.xingin.xhs", label: "小红书", ts: t0, event: "switch" },
      { app: "com.tencent.mm", label: "微信", ts: t0 + 3 * 60_000, event: "switch" },
      { app: "tv.danmaku.bili", label: "哔哩哔哩", ts: t0 + 8 * 60_000, event: "switch" },
    ],
  });
  const res3 = await watcher.sample();
  assert.equal(res3.triggered, true);
  assert.equal(res3.continuousActiveMs, 10 * 60_000);
  assert.equal(res3.currentApp, "哔哩哔哩");
  assert.ok(res3.recentApps.includes("哔哩哔哩"));
  assert.ok(res3.recentApps.includes("微信"));
  assert.ok(res3.recentApps.includes("小红书"));
});

test("18. Section VII.4: screen off -> reset", async () => {
  let currentTime = 1_700_000_000_000;
  const t0 = currentTime;
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

  // Active at t0 and t0 + 5m
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: t0 },
  });
  await watcher.sample();

  currentTime = t0 + 5 * 60_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: currentTime },
  });
  await watcher.sample();
  assert.equal(stateStore.getState().continuousActiveMs, 5 * 60_000);

  // Screen turned off!
  currentTime = t0 + 7 * 60_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: false, lastHeartbeatTs: currentTime },
  });
  const res = await watcher.sample();
  assert.equal(res.triggered, false);
  assert.equal(res.reason, "screen_off");

  const state = stateStore.getState();
  assert.equal(state.sessionStartedAt, null);
  assert.equal(state.continuousActiveMs, 0);
  assert.ok(state.lastResetAt);
});

test("19. Section VII.5: heartbeat 停止/stale -> unknown/inactive 不继续虚假累计", async () => {
  let currentTime = 1_700_000_000_000;
  const t0 = currentTime;
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
    heartbeatStaleMs: 180_000,
  });

  // Active at t0
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: t0 },
  });
  await watcher.sample();

  // At t0 + 5m, phone crashed or disconnected; heartbeat stopped at t0 + 1m (4m ago > 180s stale)
  currentTime = t0 + 5 * 60_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: t0 + 60_000 },
  });
  const res = await watcher.sample();
  assert.equal(res.triggered, false);
  assert.equal(res.reason, "heartbeat_stale");

  const state = stateStore.getState();
  assert.equal(state.sessionStartedAt, null);
  assert.equal(state.continuousActiveMs, 0);
  assert.equal(queueStore.messages.length, 0);
});

test("20. Section VII.6: PC/Veglia server 暂时断连 -> 不误认为用户一直玩手机", async () => {
  let currentTime = 1_700_000_000_000;
  const t0 = currentTime;
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

  // Active at t0
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: t0 },
  });
  await watcher.sample();

  // Network connection error
  currentTime = t0 + 5 * 60_000;
  mockSource.setResponse({ ok: false, error: "fetch failed: ECONNREFUSED" });
  const res = await watcher.sample();
  assert.equal(res.triggered, false);
  assert.equal(res.reason, "offline");

  // Does not falsely accumulate continuousActiveMs
  assert.equal(queueStore.messages.length, 0);
});

test("21. Section VII.7: 旧 schema 只有 events -> 不崩溃且 fallback 行为明确", async () => {
  let currentTime = 1_700_000_000_000;
  const t0 = currentTime;
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

  // Legacy schema: no "current" property
  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: t0, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: t0, event: "switch" },
  });
  const res1 = await watcher.sample();
  assert.equal(res1.triggered, false);
  assert.equal(res1.legacy, true);

  currentTime = t0 + 10 * 60_000;
  mockSource.setResponse({
    ok: true,
    events: [{ app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" }],
    mostRecent: { app: "com.xingin.xhs", label: "小红书", ts: currentTime, event: "switch" },
  });
  const res2 = await watcher.sample();
  assert.equal(res2.triggered, true);
  assert.equal(res2.legacy, true);
  assert.equal(queueStore.messages.length, 1);
});

test("22. Section VII.8 & VII.9: 普通 sample 不调用 AGY，达到 threshold 才 enqueue source=phone_watch", async () => {
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
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: currentTime },
  });

  // Sample 1 at 0m: no trigger, 0 enqueued
  await watcher.sample();
  assert.equal(queueStore.messages.length, 0);

  // Sample 2 at 5m: no trigger, 0 enqueued
  currentTime += 5 * 60_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: currentTime },
  });
  await watcher.sample();
  assert.equal(queueStore.messages.length, 0);

  // Sample 3 at 10m: threshold reached -> exactly 1 message enqueued with source=phone_watch
  currentTime += 5 * 60_000;
  mockSource.setResponse({
    ok: true,
    current: { app: "com.xingin.xhs", screenInteractive: true, lastHeartbeatTs: currentTime },
  });
  await watcher.sample();
  assert.equal(queueStore.messages.length, 1);
  assert.equal(queueStore.messages[0].source, "phone_watch");
});

test("23. VegliaActivitySource: parses current field and resolves token without hardcoded paths", async () => {
  const fakeFetch = async (url, opts) => {
    assert.equal(opts.headers["X-Auth-Token"], "test-veglia-token");
    return {
      ok: true,
      json: async () => ({
        ok: true,
        current: {
          app: "com.xingin.xhs",
          screenInteractive: true,
          lastHeartbeatTs: 1_700_000_123_456,
        },
        events: [
          { app: "com.xingin.xhs", ts: 1_700_000_100_000, event: "switch" },
        ],
      }),
    };
  };

  const source = new VegliaActivitySource({
    token: "test-veglia-token",
    fetchFn: fakeFetch,
  });

  const res = await source.getActivity();
  assert.equal(res.ok, true);
  assert.ok(res.current);
  assert.equal(res.current.app, "com.xingin.xhs");
  assert.equal(res.current.label, "小红书");
  assert.equal(res.current.screenInteractive, true);
  assert.equal(res.current.lastHeartbeatTs, 1_700_000_123_456);
});
