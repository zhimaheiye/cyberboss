const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { loadPersistedContextTokens } = require("../adapters/channel/weixin/context-token-store");
const { ReminderQueueStore } = require("../adapters/channel/weixin/reminder-queue-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { resolvePreferredSenderId } = require("../core/default-targets");
const {
  PersistentRuleStore,
  formatLocalDate,
  formatLocalTime,
  DEFAULT_TIMEZONE,
  DEFAULT_MIN_INACTIVE_MINUTES,
} = require("../core/persistent-rule-store");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");

const DEFAULT_HEARTBEAT_STALE_MS = 180_000;

function isWakeCandidate({
  sample,
  previousState = {},
  minInactiveMinutes = DEFAULT_MIN_INACTIVE_MINUTES,
  heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS,
  nowMs = Date.now(),
} = {}) {
  if (!sample || sample.ok === false) {
    return { isWake: false, reason: "sample_invalid" };
  }

  const current = sample.current;
  if (!current || typeof current !== "object") {
    return { isWake: false, reason: "missing_current_data" };
  }

  if (current.screenInteractive !== true) {
    return { isWake: false, reason: "screen_not_interactive" };
  }

  const lastHeartbeatTs = Number(current.lastHeartbeatTs) || 0;
  if (!lastHeartbeatTs || (nowMs - lastHeartbeatTs) > heartbeatStaleMs) {
    return { isWake: false, reason: "heartbeat_stale" };
  }

  // Resolve session start timestamp (wake time candidate)
  let sessionStartMs = null;
  if (previousState.sessionStartedAt) {
    const parsed = Date.parse(previousState.sessionStartedAt);
    if (Number.isFinite(parsed)) {
      sessionStartMs = parsed;
    }
  }

  const events = Array.isArray(sample.events) ? sample.events : [];
  const appPkg = String(current.app || "").trim();

  if (!sessionStartMs) {
    const matchingSwitch = events.length > 0 && events[events.length - 1]?.app === appPkg
      ? events[events.length - 1].ts
      : 0;
    if (matchingSwitch && matchingSwitch <= nowMs) {
      sessionStartMs = matchingSwitch;
    } else if (lastHeartbeatTs && lastHeartbeatTs <= nowMs) {
      sessionStartMs = lastHeartbeatTs;
    } else {
      sessionStartMs = nowMs;
    }
  }

  // Determine the timestamp of phone activity before this session started
  let lastInactiveBeforeSessionMs = null;
  if (previousState.lastActiveAt && !previousState.sessionStartedAt) {
    lastInactiveBeforeSessionMs = Date.parse(previousState.lastActiveAt);
  } else if (previousState.lastResetAt) {
    lastInactiveBeforeSessionMs = Date.parse(previousState.lastResetAt);
  } else if (previousState.lastActiveAt) {
    lastInactiveBeforeSessionMs = Date.parse(previousState.lastActiveAt);
  }

  if (!Number.isFinite(lastInactiveBeforeSessionMs)) {
    return { isWake: false, reason: "no_prior_activity_history" };
  }

  const inactiveGapMs = sessionStartMs - lastInactiveBeforeSessionMs;
  const minInactiveMs = minInactiveMinutes * 60_000;

  if (inactiveGapMs < minInactiveMs) {
    return {
      isWake: false,
      reason: "inactive_gap_too_short",
      inactiveGapMs,
      minInactiveMs,
      inactiveMinutes: Math.round(inactiveGapMs / 60_000),
    };
  }

  return {
    isWake: true,
    wakeTimeMs: sessionStartMs,
    inactiveGapMs,
    minInactiveMs,
    inactiveMinutes: Math.round(inactiveGapMs / 60_000),
  };
}

class PersistentRuleScheduler {
  constructor(options = {}) {
    this.config = options.config || {};
    this.ruleStore = options.ruleStore || new PersistentRuleStore({ filePath: this.config.persistentRulesFile });
    this.reminderQueue = options.reminderQueue || (this.config.reminderQueueFile ? new ReminderQueueStore({ filePath: this.config.reminderQueueFile }) : null);
    this.systemMessageQueue = options.systemMessageQueue || (this.config.systemMessageQueueFile ? new SystemMessageQueueStore({ filePath: this.config.systemMessageQueueFile }) : null);
    this.sessionStore = options.sessionStore || (this.config.sessionsFile ? new SessionStore({ filePath: this.config.sessionsFile }) : null);
    this.clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  }

  resolveTarget(explicitAccount = null) {
    const account = explicitAccount || (this.config ? resolveSelectedAccount(this.config) : null);
    if (!account || !account.accountId) {
      return null;
    }
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: account.accountId,
      sessionStore: this.sessionStore,
    });
    if (!senderId) {
      return null;
    }

    const contextTokens = loadPersistedContextTokens(this.config, account.accountId) || {};
    const contextToken = String(contextTokens[senderId] || "").trim();
    if (!contextToken) {
      return null;
    }

    return {
      accountId: account.accountId,
      senderId,
      contextToken,
    };
  }

  isReminderAlreadyQueued(dedupeId) {
    if (this.reminderQueue && typeof this.reminderQueue.has === "function" && this.reminderQueue.has(dedupeId)) {
      return true;
    }
    if (this.systemMessageQueue && typeof this.systemMessageQueue.has === "function") {
      if (this.systemMessageQueue.has(dedupeId) || this.systemMessageQueue.has(`reminder:${dedupeId}`)) {
        return true;
      }
    }
    return false;
  }

  evaluateWakeActivity({ sample, watcherState = {}, account = null, nowMs = this.clock() } = {}) {
    const rules = this.ruleStore.getRules().filter((rule) => rule.enabled && rule.type === "wake_followup");
    if (rules.length === 0) {
      return [];
    }

    const target = this.resolveTarget(account);
    if (!target) {
      console.warn("[cyberboss] persistent rule cannot resolve active WeChat target with valid context token");
      return [];
    }

    const createdReminders = [];

    for (const rule of rules) {
      const timezone = rule.timezone || DEFAULT_TIMEZONE;
      const localDate = formatLocalDate(nowMs, timezone);
      const dedupeId = `persistent-rule:${rule.id}:${localDate}`;

      if (rule.lastTriggeredLocalDate === localDate) {
        continue;
      }

      if (this.isReminderAlreadyQueued(dedupeId)) {
        console.log(`[cyberboss] persistent rule skipped duplicate rule=${rule.id} date=${localDate}`);
        this.ruleStore.recordTrigger(rule.id, {
          triggeredAt: new Date(nowMs).toISOString(),
          localDate,
        });
        continue;
      }

      const minInactiveMinutes = Number(rule.config?.minInactiveMinutes) || DEFAULT_MIN_INACTIVE_MINUTES;
      const heartbeatStaleMs = Number(this.config?.phoneWatchHeartbeatStaleMs) || DEFAULT_HEARTBEAT_STALE_MS;

      const candidate = isWakeCandidate({
        sample,
        previousState: watcherState,
        minInactiveMinutes,
        heartbeatStaleMs,
        nowMs,
      });

      if (!candidate.isWake) {
        continue;
      }

      const wakeTimeMs = candidate.wakeTimeMs;
      const delayMinutes = Number.isFinite(rule.delayMinutes) ? rule.delayMinutes : 60;
      const scheduledDueAtMs = wakeTimeMs + delayMinutes * 60_000;
      const effectiveDueAtMs = scheduledDueAtMs <= nowMs ? nowMs : scheduledDueAtMs;

      console.log(`[cyberboss] persistent rule triggered rule=${rule.id} type=${rule.type} date=${localDate}`);

      const reminder = {
        id: dedupeId,
        accountId: target.accountId,
        senderId: target.senderId,
        contextToken: target.contextToken,
        text: rule.reminderText || "醒来一小时到啦，该开始学习啦～",
        dueAtMs: effectiveDueAtMs,
        createdAt: new Date(nowMs).toISOString(),
        origin: "user",
        deliveryRequired: true,
        source: "persistent_rule",
        ruleId: rule.id,
      };

      if (this.reminderQueue) {
        this.reminderQueue.enqueue(reminder);
        console.log(`[cyberboss] persistent rule reminder queued rule=${rule.id} reminder=${reminder.id} dueAt=${new Date(reminder.dueAtMs).toISOString()}`);
      }

      this.ruleStore.recordTrigger(rule.id, {
        triggeredAt: new Date(nowMs).toISOString(),
        localDate,
      });

      createdReminders.push(reminder);
    }

    return createdReminders;
  }

  evaluateDailyRules({ account = null, nowMs = this.clock() } = {}) {
    const rules = this.ruleStore.getRules().filter((rule) => rule.enabled && rule.type === "daily_time");
    if (rules.length === 0) {
      return [];
    }

    const target = this.resolveTarget(account);
    if (!target) {
      return [];
    }

    const createdReminders = [];

    for (const rule of rules) {
      if (!rule.localTime || typeof rule.localTime !== "string") {
        continue;
      }

      const timezone = rule.timezone || DEFAULT_TIMEZONE;
      const localDate = formatLocalDate(nowMs, timezone);
      const currentLocalTime = formatLocalTime(nowMs, timezone);
      const dedupeId = `persistent-rule:${rule.id}:${localDate}`;

      if (rule.lastTriggeredLocalDate === localDate) {
        continue;
      }

      if (this.isReminderAlreadyQueued(dedupeId)) {
        console.log(`[cyberboss] persistent rule skipped duplicate rule=${rule.id} date=${localDate}`);
        this.ruleStore.recordTrigger(rule.id, {
          triggeredAt: new Date(nowMs).toISOString(),
          localDate,
        });
        continue;
      }

      if (currentLocalTime >= rule.localTime) {
        console.log(`[cyberboss] persistent rule triggered rule=${rule.id} type=${rule.type} date=${localDate}`);

        const reminder = {
          id: dedupeId,
          accountId: target.accountId,
          senderId: target.senderId,
          contextToken: target.contextToken,
          text: rule.reminderText || "日常定时提醒到啦～",
          dueAtMs: nowMs,
          createdAt: new Date(nowMs).toISOString(),
          origin: "user",
          deliveryRequired: true,
          source: "persistent_rule",
          ruleId: rule.id,
        };

        if (this.reminderQueue) {
          this.reminderQueue.enqueue(reminder);
          console.log(`[cyberboss] persistent rule reminder queued rule=${rule.id} reminder=${reminder.id} dueAt=${new Date(reminder.dueAtMs).toISOString()}`);
        }

        this.ruleStore.recordTrigger(rule.id, {
          triggeredAt: new Date(nowMs).toISOString(),
          localDate,
        });

        createdReminders.push(reminder);
      }
    }

    return createdReminders;
  }
}

module.exports = {
  isWakeCandidate,
  PersistentRuleScheduler,
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_MIN_INACTIVE_MINUTES,
};
