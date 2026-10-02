const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  PersistentRuleStore,
  formatLocalDate,
  formatLocalTime,
  DEFAULT_MIN_INACTIVE_MINUTES,
} = require("../src/core/persistent-rule-store");
const {
  PersistentRuleScheduler,
  isWakeCandidate,
} = require("../src/app/persistent-rule-scheduler");
const { ReminderQueueStore } = require("../src/adapters/channel/weixin/reminder-queue-store");
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");
const { SessionStore } = require("../src/adapters/runtime/codex/session-store");
const { ReminderService } = require("../src/services/reminder-service");

function createTestEnvironment() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-rules-test-"));
  const persistentRulesFile = path.join(tempDir, "persistent-rules.json");
  const reminderQueueFile = path.join(tempDir, "reminder-queue.json");
  const systemMessageQueueFile = path.join(tempDir, "system-message-queue.json");
  const sessionsFile = path.join(tempDir, "sessions.json");
  const accountsDir = path.join(tempDir, "accounts");
  const accountId = "test-bot-account";
  fs.mkdirSync(accountsDir, { recursive: true });

  const testUser = "test_user_1@im.wechat";
  const contextTokens = { [testUser]: "token_user_1" };
  fs.writeFileSync(path.join(accountsDir, `${accountId}.json`), JSON.stringify({
    accountId,
    rawAccountId: accountId,
    token: "valid-bot-token",
    baseUrl: "https://ilinkai.weixin.qq.com",
    savedAt: new Date().toISOString(),
  }, null, 2));
  fs.writeFileSync(path.join(accountsDir, `${accountId}.context-tokens.json`), JSON.stringify(contextTokens, null, 2));

  const sessionStore = new SessionStore({ filePath: sessionsFile });
  sessionStore.updateBinding(`default:${accountId}:${testUser}`, {
    bindingKey: `default:${accountId}:${testUser}`,
    workspaceId: "default",
    accountId,
    senderId: testUser,
    activeWorkspaceRoot: tempDir,
  });

  const config = {
    stateDir: tempDir,
    accountsDir,
    accountId,
    workspaceId: "default",
    workspaceRoot: tempDir,
    persistentRulesFile,
    reminderQueueFile,
    systemMessageQueueFile,
    sessionsFile,
    phoneWatchHeartbeatStaleMs: 180_000,
  };

  const ruleStore = new PersistentRuleStore({ filePath: persistentRulesFile });
  const reminderQueue = new ReminderQueueStore({ filePath: reminderQueueFile });
  const systemMessageQueue = new SystemMessageQueueStore({ filePath: systemMessageQueueFile });

  const scheduler = new PersistentRuleScheduler({
    config,
    ruleStore,
    reminderQueue,
    systemMessageQueue,
    sessionStore,
  });

  const cleanup = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return {
    tempDir,
    config,
    ruleStore,
    reminderQueue,
    systemMessageQueue,
    sessionStore,
    scheduler,
    testUser,
    accountId,
    cleanup,
  };
}

test("1. wake candidate + 当天未触发 -> 创建 user reminder, deliveryRequired=true", () => {
  const env = createTestEnvironment();
  try {
    const nowMs = Date.parse("2026-09-14T08:00:00+08:00");
    const lastNightMs = Date.parse("2026-09-13T23:00:00+08:00"); // 9 hours inactive

    const sample = {
      ok: true,
      current: {
        screenInteractive: true,
        lastHeartbeatTs: nowMs - 10_000,
        app: "com.tencent.mm",
      },
      events: [{ app: "com.tencent.mm", ts: nowMs - 10_000 }],
    };
    const watcherState = {
      sessionStartedAt: null,
      lastActiveAt: new Date(lastNightMs).toISOString(),
      lastResetAt: new Date(lastNightMs).toISOString(),
    };

    const reminders = env.scheduler.evaluateWakeActivity({
      sample,
      watcherState,
      nowMs,
    });

    assert.equal(reminders.length, 1);
    const r = reminders[0];
    assert.equal(r.origin, "user");
    assert.equal(r.deliveryRequired, true);
    assert.equal(r.senderId, env.testUser);
    assert.equal(r.contextToken, "token_user_1");
    assert.equal(r.id, "persistent-rule:wake-followup-learn:2026-09-14");

    // Persisted in reminder queue
    const queued = env.reminderQueue.find(r.id);
    assert.ok(queued);
    assert.equal(queued.origin, "user");
    assert.equal(queued.deliveryRequired, true);

    // Rule store updated
    const rule = env.ruleStore.getRule("wake-followup-learn");
    assert.equal(rule.lastTriggeredLocalDate, "2026-09-14");
  } finally {
    env.cleanup();
  }
});

test("2. wake candidate -> dueAt = wakeTime + delayMinutes", () => {
  const env = createTestEnvironment();
  try {
    const wakeTimeMs = Date.parse("2026-09-14T08:05:00+08:00");
    const nowMs = wakeTimeMs + 60_000; // 08:06 (1 minute later sample)
    const lastNightMs = Date.parse("2026-09-13T23:00:00+08:00");

    const sample = {
      ok: true,
      current: {
        screenInteractive: true,
        lastHeartbeatTs: wakeTimeMs,
        app: "com.tencent.mm",
      },
      events: [{ app: "com.tencent.mm", ts: wakeTimeMs }],
    };
    const watcherState = {
      sessionStartedAt: new Date(wakeTimeMs).toISOString(),
      lastActiveAt: new Date(lastNightMs).toISOString(),
      lastResetAt: new Date(lastNightMs).toISOString(),
    };

    const reminders = env.scheduler.evaluateWakeActivity({
      sample,
      watcherState,
      nowMs,
    });

    assert.equal(reminders.length, 1);
    const expectedDueAt = wakeTimeMs + 60 * 60_000; // 09:05:00
    assert.equal(reminders[0].dueAtMs, expectedDueAt);
  } finally {
    env.cleanup();
  }
});

test("3. 同一天再次活跃 -> 不重复创建", () => {
  const env = createTestEnvironment();
  try {
    const wakeTimeMs = Date.parse("2026-09-14T08:00:00+08:00");
    const lastNightMs = Date.parse("2026-09-13T23:00:00+08:00");

    const sample1 = {
      ok: true,
      current: {
        screenInteractive: true,
        lastHeartbeatTs: wakeTimeMs,
        app: "com.tencent.mm",
      },
      events: [{ app: "com.tencent.mm", ts: wakeTimeMs }],
    };
    const watcherState = {
      sessionStartedAt: null,
      lastActiveAt: new Date(lastNightMs).toISOString(),
      lastResetAt: new Date(lastNightMs).toISOString(),
    };

    const first = env.scheduler.evaluateWakeActivity({ sample: sample1, watcherState, nowMs: wakeTimeMs });
    assert.equal(first.length, 1);

    // Later that day (e.g. afternoon 14:00)
    const afternoonMs = Date.parse("2026-09-14T14:00:00+08:00");
    const sample2 = {
      ok: true,
      current: {
        screenInteractive: true,
        lastHeartbeatTs: afternoonMs,
        app: "com.xingin.xhs",
      },
      events: [{ app: "com.xingin.xhs", ts: afternoonMs }],
    };
    const second = env.scheduler.evaluateWakeActivity({ sample: sample2, watcherState, nowMs: afternoonMs });
    assert.equal(second.length, 0);

    // Reminder queue still has exactly 1 reminder
    assert.equal(env.reminderQueue.state.reminders.length, 1);
  } finally {
    env.cleanup();
  }
});

test("4. 次日重新允许触发", () => {
  const env = createTestEnvironment();
  try {
    const day1WakeMs = Date.parse("2026-09-14T08:00:00+08:00");
    const day0NightMs = Date.parse("2026-09-13T23:00:00+08:00");

    const sample1 = {
      ok: true,
      current: {
        screenInteractive: true,
        lastHeartbeatTs: day1WakeMs,
        app: "com.tencent.mm",
      },
      events: [{ app: "com.tencent.mm", ts: day1WakeMs }],
    };
    env.scheduler.evaluateWakeActivity({
      sample: sample1,
      watcherState: { lastActiveAt: new Date(day0NightMs).toISOString() },
      nowMs: day1WakeMs,
    });
    assert.equal(env.reminderQueue.state.reminders.length, 1);

    // Day 2 morning (2026-09-15)
    const day2WakeMs = Date.parse("2026-09-15T07:30:00+08:00");
    const day1NightMs = Date.parse("2026-09-14T23:30:00+08:00"); // 8 hours gap

    const sample2 = {
      ok: true,
      current: {
        screenInteractive: true,
        lastHeartbeatTs: day2WakeMs,
        app: "com.tencent.mm",
      },
      events: [{ app: "com.tencent.mm", ts: day2WakeMs }],
    };
    const day2Reminders = env.scheduler.evaluateWakeActivity({
      sample: sample2,
      watcherState: { lastActiveAt: new Date(day1NightMs).toISOString() },
      nowMs: day2WakeMs,
    });

    assert.equal(day2Reminders.length, 1);
    assert.equal(day2Reminders[0].id, "persistent-rule:wake-followup-learn:2026-09-15");
    assert.equal(env.reminderQueue.state.reminders.length, 2);
  } finally {
    env.cleanup();
  }
});

test("5. inactive gap 不足 -> 不认为是 wake", () => {
  const env = createTestEnvironment();
  try {
    const nowMs = Date.parse("2026-09-14T15:00:00+08:00");
    const lastActiveMs = Date.parse("2026-09-14T14:30:00+08:00"); // 30 min gap < 360 min

    const sample = {
      ok: true,
      current: {
        screenInteractive: true,
        lastHeartbeatTs: nowMs,
        app: "com.tencent.mm",
      },
    };
    const watcherState = {
      sessionStartedAt: null,
      lastActiveAt: new Date(lastActiveMs).toISOString(),
    };

    const candidate = isWakeCandidate({
      sample,
      previousState: watcherState,
      minInactiveMinutes: DEFAULT_MIN_INACTIVE_MINUTES,
      nowMs,
    });
    assert.equal(candidate.isWake, false);
    assert.equal(candidate.reason, "inactive_gap_too_short");

    const reminders = env.scheduler.evaluateWakeActivity({ sample, watcherState, nowMs });
    assert.equal(reminders.length, 0);
  } finally {
    env.cleanup();
  }
});

test("6. heartbeat stale / screenInteractive=false -> 不触发", () => {
  const env = createTestEnvironment();
  try {
    const nowMs = Date.parse("2026-09-14T08:00:00+08:00");
    const lastNightMs = Date.parse("2026-09-13T23:00:00+08:00");
    const watcherState = {
      sessionStartedAt: null,
      lastActiveAt: new Date(lastNightMs).toISOString(),
    };

    // Subcase 6a: screenInteractive === false
    const screenOffSample = {
      ok: true,
      current: {
        screenInteractive: false,
        lastHeartbeatTs: nowMs,
        app: "com.tencent.mm",
      },
    };
    const candidateA = isWakeCandidate({ sample: screenOffSample, previousState: watcherState, nowMs });
    assert.equal(candidateA.isWake, false);
    assert.equal(candidateA.reason, "screen_not_interactive");

    const remindersA = env.scheduler.evaluateWakeActivity({ sample: screenOffSample, watcherState, nowMs });
    assert.equal(remindersA.length, 0);

    // Subcase 6b: heartbeat stale (heartbeat 5 minutes ago > 3 minutes threshold)
    const staleHeartbeatSample = {
      ok: true,
      current: {
        screenInteractive: true,
        lastHeartbeatTs: nowMs - 300_000,
        app: "com.tencent.mm",
      },
    };
    const candidateB = isWakeCandidate({
      sample: staleHeartbeatSample,
      previousState: watcherState,
      heartbeatStaleMs: 180_000,
      nowMs,
    });
    assert.equal(candidateB.isWake, false);
    assert.equal(candidateB.reason, "heartbeat_stale");

    const remindersB = env.scheduler.evaluateWakeActivity({ sample: staleHeartbeatSample, watcherState, nowMs });
    assert.equal(remindersB.length, 0);
  } finally {
    env.cleanup();
  }
});

test("7. 重启时 dueAt 已经过 -> 创建立即到期 reminder", () => {
  const env = createTestEnvironment();
  try {
    // User woke up at 07:00, delay is 60m (due at 08:00).
    // CyberBoss was offline and booted at 08:30 (30m after dueAt).
    const wakeTimeMs = Date.parse("2026-09-14T07:00:00+08:00");
    const restartNowMs = Date.parse("2026-09-14T08:30:00+08:00");
    const lastNightMs = Date.parse("2026-09-13T23:00:00+08:00");

    const sample = {
      ok: true,
      current: {
        screenInteractive: true,
        lastHeartbeatTs: restartNowMs - 5_000,
        app: "com.tencent.mm",
      },
      events: [
        { app: "com.tencent.mm", ts: wakeTimeMs },
      ],
    };
    const watcherState = {
      sessionStartedAt: new Date(wakeTimeMs).toISOString(),
      lastActiveAt: new Date(lastNightMs).toISOString(),
    };

    const reminders = env.scheduler.evaluateWakeActivity({
      sample,
      watcherState,
      nowMs: restartNowMs,
    });

    assert.equal(reminders.length, 1);
    // Overdue: dueAt set to restartNowMs
    assert.equal(reminders[0].dueAtMs, restartNowMs);
    assert.equal(reminders[0].origin, "user");
    assert.equal(reminders[0].deliveryRequired, true);
  } finally {
    env.cleanup();
  }
});

test("8. enqueue 后、state 写入前模拟 crash -> 重启不重复创建", () => {
  const env = createTestEnvironment();
  try {
    const nowMs = Date.parse("2026-09-14T08:00:00+08:00");
    const dedupeId = "persistent-rule:wake-followup-learn:2026-09-14";

    // Simulate crash: reminder was written to queue, but persistent-rules.json crashed before lastTriggeredLocalDate was updated
    env.reminderQueue.enqueue({
      id: dedupeId,
      accountId: env.accountId,
      senderId: env.testUser,
      contextToken: "token_user_1",
      text: "醒来一小时到啦，该开始学习啦～",
      dueAtMs: nowMs + 3600_000,
      createdAt: new Date(nowMs).toISOString(),
      origin: "user",
      deliveryRequired: true,
    });

    // Verify rule store still has null lastTriggeredLocalDate (simulating crash)
    assert.equal(env.ruleStore.getRule("wake-followup-learn").lastTriggeredLocalDate, null);

    // After reboot: evaluate again
    const sample = {
      ok: true,
      current: {
        screenInteractive: true,
        lastHeartbeatTs: nowMs,
        app: "com.tencent.mm",
      },
      events: [{ app: "com.tencent.mm", ts: nowMs }],
    };
    const watcherState = {
      lastActiveAt: "2026-09-13T23:00:00.000Z",
    };

    const reminders = env.scheduler.evaluateWakeActivity({ sample, watcherState, nowMs });
    assert.equal(reminders.length, 0); // Not created again!

    // Queue still has exactly 1 reminder
    assert.equal(env.reminderQueue.state.reminders.length, 1);

    // Rule store reconciled
    assert.equal(env.ruleStore.getRule("wake-followup-learn").lastTriggeredLocalDate, "2026-09-14");
  } finally {
    env.cleanup();
  }
});

test("9. daily_time 到点 -> 创建必达 user reminder", () => {
  const env = createTestEnvironment();
  try {
    // Add an enabled daily rule at 22:30
    env.ruleStore.updateRule("daily-study", {
      id: "daily-study",
      type: "daily_time",
      enabled: true,
      localTime: "22:30",
      reminderText: "该每日复盘啦～",
    });
    // Add rule to store manually if updateRule returned null
    if (!env.ruleStore.getRule("daily-study")) {
      env.ruleStore.state.rules.push({
        id: "daily-study",
        type: "daily_time",
        enabled: true,
        localTime: "22:30",
        reminderText: "该每日复盘啦～",
        lastTriggeredLocalDate: null,
      });
      env.ruleStore.save();
    }

    const nowMs = Date.parse("2026-09-14T22:30:15+08:00");
    const reminders = env.scheduler.evaluateDailyRules({ nowMs });

    assert.equal(reminders.length, 1);
    const r = reminders[0];
    assert.equal(r.id, "persistent-rule:daily-study:2026-09-14");
    assert.equal(r.origin, "user");
    assert.equal(r.deliveryRequired, true);
    assert.equal(r.text, "该每日复盘啦～");
    assert.equal(r.dueAtMs, nowMs);

    // Stored in reminder queue
    const queued = env.reminderQueue.find(r.id);
    assert.ok(queued);
    assert.equal(queued.origin, "user");
    assert.equal(queued.deliveryRequired, true);

    // State recorded
    assert.equal(env.ruleStore.getRule("daily-study").lastTriggeredLocalDate, "2026-09-14");
  } finally {
    env.cleanup();
  }
});

test("10. daily_time 目标时间后才启动 -> 当天补触发", () => {
  const env = createTestEnvironment();
  try {
    env.ruleStore.state.rules.push({
      id: "daily-workout",
      type: "daily_time",
      enabled: true,
      localTime: "18:00",
      reminderText: "运动时间到啦！",
      lastTriggeredLocalDate: null,
    });
    env.ruleStore.save();

    // Booted at 20:00 (2 hours after 18:00)
    const bootNowMs = Date.parse("2026-09-14T20:00:00+08:00");
    const reminders = env.scheduler.evaluateDailyRules({ nowMs: bootNowMs });

    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].id, "persistent-rule:daily-workout:2026-09-14");
    assert.equal(reminders[0].dueAtMs, bootNowMs);
    assert.equal(reminders[0].deliveryRequired, true);
  } finally {
    env.cleanup();
  }
});

test("11. daily_time 同日不重复", () => {
  const env = createTestEnvironment();
  try {
    env.ruleStore.state.rules.push({
      id: "daily-standup",
      type: "daily_time",
      enabled: true,
      localTime: "10:00",
      reminderText: "晨会时间",
      lastTriggeredLocalDate: null,
    });
    env.ruleStore.save();

    const t1 = Date.parse("2026-09-14T10:01:00+08:00");
    const first = env.scheduler.evaluateDailyRules({ nowMs: t1 });
    assert.equal(first.length, 1);

    const t2 = Date.parse("2026-09-14T10:05:00+08:00");
    const second = env.scheduler.evaluateDailyRules({ nowMs: t2 });
    assert.equal(second.length, 0);

    assert.equal(env.reminderQueue.state.reminders.length, 1);
  } finally {
    env.cleanup();
  }
});

test("12. disabled rule 不执行", () => {
  const env = createTestEnvironment();
  try {
    env.ruleStore.updateRule("wake-followup-learn", { enabled: false });

    const nowMs = Date.parse("2026-09-14T08:00:00+08:00");
    const sample = {
      ok: true,
      current: {
        screenInteractive: true,
        lastHeartbeatTs: nowMs,
        app: "com.tencent.mm",
      },
      events: [{ app: "com.tencent.mm", ts: nowMs }],
    };
    const watcherState = {
      lastActiveAt: "2026-09-13T23:00:00.000Z",
    };

    const reminders = env.scheduler.evaluateWakeActivity({ sample, watcherState, nowMs });
    assert.equal(reminders.length, 0);
  } finally {
    env.cleanup();
  }
});

test("13. bedtime rule enabled=false -> 不产生消息", () => {
  const env = createTestEnvironment();
  try {
    const bedtimeRule = env.ruleStore.getRule("bedtime-daily");
    assert.ok(bedtimeRule);
    assert.equal(bedtimeRule.enabled, false);
    assert.equal(bedtimeRule.localTime, null);

    // Evaluate across different night times
    const times = [
      "2026-09-14T22:00:00+08:00",
      "2026-09-14T23:00:00+08:00",
      "2026-09-14T23:30:00+08:00",
      "2026-09-15T01:30:00+08:00",
    ];

    for (const timeStr of times) {
      const nowMs = Date.parse(timeStr);
      const reminders = env.scheduler.evaluateDailyRules({ nowMs });
      assert.equal(reminders.length, 0);
    }
  } finally {
    env.cleanup();
  }
});

test("14. persistent rule 生成的 reminder -> origin=user, deliveryRequired=true", () => {
  const env = createTestEnvironment();
  try {
    const wakeMs = Date.parse("2026-09-14T08:00:00+08:00");
    const sample = {
      ok: true,
      current: {
        screenInteractive: true,
        lastHeartbeatTs: wakeMs,
        app: "com.tencent.mm",
      },
      events: [{ app: "com.tencent.mm", ts: wakeMs }],
    };
    const lastNightMs = Date.parse("2026-09-13T22:00:00+08:00");
    const watcherState = {
      lastActiveAt: new Date(lastNightMs).toISOString(),
    };

    const wakeReminders = env.scheduler.evaluateWakeActivity({ sample, watcherState, nowMs: wakeMs });
    assert.equal(wakeReminders.length, 1);
    assert.equal(wakeReminders[0].origin, "user");
    assert.equal(wakeReminders[0].deliveryRequired, true);

    // Verify daily_time
    env.ruleStore.state.rules.push({
      id: "test-daily",
      type: "daily_time",
      enabled: true,
      localTime: "12:00",
      reminderText: "午饭提醒",
      lastTriggeredLocalDate: null,
    });
    env.ruleStore.save();

    const dailyReminders = env.scheduler.evaluateDailyRules({ nowMs: Date.parse("2026-09-14T12:05:00+08:00") });
    assert.equal(dailyReminders.length, 1);
    assert.equal(dailyReminders[0].origin, "user");
    assert.equal(dailyReminders[0].deliveryRequired, true);
  } finally {
    env.cleanup();
  }
});

test("15. existing user reminder/internal reminder 行为不变", async () => {
  const env = createTestEnvironment();
  try {
    const reminderService = new ReminderService({
      config: env.config,
      sessionStore: env.sessionStore,
    });

    // Create user reminder
    const userReminder = await reminderService.create({
      text: "用户手动提醒",
      delayMinutes: 10,
      userId: env.testUser,
      origin: "user",
    });
    assert.equal(userReminder.origin, "user");
    assert.equal(userReminder.deliveryRequired, true);

    // Create internal reminder
    const internalReminder = await reminderService.create({
      text: "AGY内部提醒",
      delayMinutes: 20,
      userId: env.testUser,
      origin: "internal",
    });
    assert.equal(internalReminder.origin, "internal");
    assert.equal(internalReminder.deliveryRequired, false);

    // Both coexist in reminder queue
    env.reminderQueue.load();
    assert.equal(env.reminderQueue.state.reminders.length, 2);
  } finally {
    env.cleanup();
  }
});
