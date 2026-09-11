const crypto = require("crypto");
const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");
const { VegliaActivitySource, DEFAULT_APP_LABELS } = require("../adapters/veglia/client");
const { PhoneWatchStateStore } = require("../core/phone-watch-state-store");

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_TRIGGER_AFTER_MS = 10 * 60_000;
const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_INACTIVE_RESET_MS = 10 * 60_000;
const DEFAULT_HEARTBEAT_STALE_MS = 180_000;

class PhoneActivityWatcher {
  constructor(options = {}) {
    this.config = options.config || {};
    this.intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0
      ? options.intervalMs
      : (this.config.phoneWatchIntervalMs || DEFAULT_INTERVAL_MS);
    this.triggerAfterMs = Number.isFinite(options.triggerAfterMs) && options.triggerAfterMs > 0
      ? options.triggerAfterMs
      : (this.config.phoneWatchTriggerAfterMs || DEFAULT_TRIGGER_AFTER_MS);
    this.triggerCooldownMs = Number.isFinite(options.triggerCooldownMs) && options.triggerCooldownMs > 0
      ? options.triggerCooldownMs
      : (this.config.phoneWatchTriggerCooldownMs || DEFAULT_COOLDOWN_MS);
    this.inactiveResetMs = Number.isFinite(options.inactiveResetMs) && options.inactiveResetMs > 0
      ? options.inactiveResetMs
      : (this.config.phoneWatchInactiveResetMs || DEFAULT_INACTIVE_RESET_MS);
    this.heartbeatStaleMs = Number.isFinite(options.heartbeatStaleMs) && options.heartbeatStaleMs > 0
      ? options.heartbeatStaleMs
      : (this.config.phoneWatchHeartbeatStaleMs || DEFAULT_HEARTBEAT_STALE_MS);

    this.clock = typeof options.clock === "function" ? options.clock : () => Date.now();
    this.activitySource = options.activitySource || new VegliaActivitySource(this.config);
    this.stateStore = options.stateStore || new PhoneWatchStateStore({ filePath: this.config.phoneWatchStateFile });
    this.queueStore = options.queueStore || (this.config.systemMessageQueueFile ? new SystemMessageQueueStore({ filePath: this.config.systemMessageQueueFile }) : null);

    this.account = options.account || (options.config ? resolveSelectedAccount(this.config) : null);
    this.sessionStore = options.sessionStore || (options.config?.sessionsFile ? new SessionStore({ filePath: this.config.sessionsFile }) : null);
    this.target = options.target || (this.account && this.sessionStore ? resolvePollerTarget({ config: this.config, account: this.account, sessionStore: this.sessionStore }) : null);
  }

  evaluateSample(sampleData, nowMs = this.clock()) {
    const isoNow = new Date(nowMs).toISOString();
    const currentState = this.stateStore.getState();

    // 1. Record sample timestamp
    const nextState = {
      ...currentState,
      lastSampleAt: isoNow,
    };

    // 2. Handle Veglia offline / error
    if (!sampleData || sampleData.ok === false) {
      if (nextState.lastActiveAt) {
        const lastActiveMs = Date.parse(nextState.lastActiveAt);
        if (Number.isFinite(lastActiveMs) && (nowMs - lastActiveMs) >= this.inactiveResetMs) {
          nextState.sessionStartedAt = null;
          nextState.continuousActiveMs = 0;
          nextState.lastResetAt = isoNow;
        }
      }
      this.stateStore.update(nextState);
      return { triggered: false, reason: "offline" };
    }

    // 3. Check if new heartbeat schema is available in sampleData
    const hasCurrent = Boolean(sampleData.current && typeof sampleData.current === "object");

    if (hasCurrent) {
      const current = sampleData.current;

      // Priority 1: screenInteractive === false -> inactive/reset
      if (current.screenInteractive === false) {
        if (nextState.sessionStartedAt) {
          nextState.sessionStartedAt = null;
          nextState.continuousActiveMs = 0;
          nextState.lastResetAt = isoNow;
        }
        this.stateStore.update(nextState);
        return { triggered: false, reason: "screen_off" };
      }

      // Priority 2 & 3: screenInteractive === true, check heartbeat freshness
      const lastHb = Number(current.lastHeartbeatTs) || 0;
      const heartbeatAge = Math.max(0, nowMs - lastHb);

      if (!lastHb || heartbeatAge > this.heartbeatStaleMs) {
        // Priority 3: Heartbeat stale -> reset session, avoid false accumulation
        if (nextState.sessionStartedAt) {
          nextState.sessionStartedAt = null;
          nextState.continuousActiveMs = 0;
          nextState.lastResetAt = isoNow;
        }
        this.stateStore.update(nextState);
        return { triggered: false, reason: "heartbeat_stale" };
      }

      // Priority 2: screenInteractive === true and heartbeat is fresh
      const appPkg = String(current.app || "").trim();
      const appLabel = current.label || (this.activitySource?.getAppLabel ? this.activitySource.getAppLabel(appPkg) : DEFAULT_APP_LABELS[appPkg]) || appPkg || "unknown";
      nextState.currentApp = appLabel;
      nextState.lastActiveAt = isoNow;

      // Determine session start
      const events = Array.isArray(sampleData.events) ? sampleData.events : [];
      if (!nextState.sessionStartedAt) {
        let effectiveStartMs = nowMs;
        const matchingSwitch = events.length > 0 && events[events.length - 1]?.app === appPkg ? events[events.length - 1].ts : 0;
        if (matchingSwitch && matchingSwitch <= nowMs && (nowMs - matchingSwitch) <= this.inactiveResetMs) {
          effectiveStartMs = matchingSwitch;
        } else if (lastHb && lastHb <= nowMs && (nowMs - lastHb) <= this.heartbeatStaleMs) {
          effectiveStartMs = lastHb;
        }
        nextState.sessionStartedAt = new Date(effectiveStartMs).toISOString();
        nextState.continuousActiveMs = Math.max(0, nowMs - effectiveStartMs);
      } else {
        const sessionStartMs = Date.parse(nextState.sessionStartedAt);
        nextState.continuousActiveMs = Math.max(0, nowMs - sessionStartMs);
      }

      // Collect recent apps
      const sessionStartMs = Date.parse(nextState.sessionStartedAt);
      const effectiveSinceMs = Number.isFinite(sessionStartMs) ? sessionStartMs : (nowMs - this.inactiveResetMs);

      const recent = [];
      const seen = new Set();
      if (appLabel && appLabel !== "unknown") {
        recent.push(appLabel);
        seen.add(appLabel);
      }
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i];
        if (ev && ev.ts && ev.ts >= effectiveSinceMs - 60_000) {
          const l = ev.label || (this.activitySource?.getAppLabel ? this.activitySource.getAppLabel(ev.app) : ev.app);
          if (l && !seen.has(l)) {
            seen.add(l);
            recent.push(l);
          }
        }
      }
      nextState.recentApps = recent.slice(0, 5);

      // Check Trigger Conditions
      const meetsActiveThreshold = nextState.continuousActiveMs >= this.triggerAfterMs;
      const lastTriggerMs = nextState.lastTriggerAt ? Date.parse(nextState.lastTriggerAt) : null;
      const cooldownElapsed = !Number.isFinite(lastTriggerMs) || (nowMs - lastTriggerMs) >= this.triggerCooldownMs;

      if (meetsActiveThreshold && cooldownElapsed) {
        const triggerText = buildPhoneWatchTriggerText({
          continuousActiveMs: nextState.continuousActiveMs,
          currentApp: nextState.currentApp,
          recentApps: nextState.recentApps,
          lastTriggerAt: nextState.lastTriggerAt,
          nowMs,
        });

        if (this.queueStore && this.target) {
          this.queueStore.enqueue({
            id: crypto.randomUUID(),
            accountId: this.target.accountId,
            senderId: this.target.senderId,
            workspaceRoot: this.target.workspaceRoot,
            text: triggerText,
            createdAt: isoNow,
            source: "phone_watch",
          });
        }

        nextState.lastTriggerAt = isoNow;
        nextState.lastTriggerContinuousMs = nextState.continuousActiveMs;
        this.stateStore.update(nextState);

        return {
          triggered: true,
          continuousActiveMs: nextState.continuousActiveMs,
          currentApp: nextState.currentApp,
          recentApps: nextState.recentApps,
          triggerText,
        };
      }

      this.stateStore.update(nextState);
      return {
        triggered: false,
        reason: !meetsActiveThreshold ? "below_threshold" : "in_cooldown",
        continuousActiveMs: nextState.continuousActiveMs,
      };
    }

    // Priority 4: Legacy fallback (events only)
    const events = Array.isArray(sampleData.events) ? sampleData.events : [];
    const mostRecent = sampleData.mostRecent || (events.length > 0 ? events[events.length - 1] : null);

    if (!mostRecent || !mostRecent.ts) {
      if (nextState.lastActiveAt) {
        const lastActiveMs = Date.parse(nextState.lastActiveAt);
        if (Number.isFinite(lastActiveMs) && (nowMs - lastActiveMs) >= this.inactiveResetMs) {
          nextState.sessionStartedAt = null;
          nextState.continuousActiveMs = 0;
          nextState.lastResetAt = isoNow;
        }
      }
      this.stateStore.update(nextState);
      return { triggered: false, reason: "no_events", legacy: true };
    }

    const timeSinceLastEvent = Math.max(0, nowMs - mostRecent.ts);
    if (timeSinceLastEvent > this.inactiveResetMs) {
      if (nextState.sessionStartedAt) {
        nextState.sessionStartedAt = null;
        nextState.continuousActiveMs = 0;
        nextState.lastResetAt = isoNow;
      }
      this.stateStore.update(nextState);
      return { triggered: false, reason: "inactive_timeout", legacy: true };
    }

    const label = mostRecent.label || mostRecent.app || "unknown";
    nextState.currentApp = label;
    nextState.lastActiveAt = isoNow;

    const sessionStartMs = nextState.sessionStartedAt ? Date.parse(nextState.sessionStartedAt) : null;
    const effectiveStartMs = Number.isFinite(sessionStartMs) ? sessionStartMs : Math.max(mostRecent.ts, nowMs - this.inactiveResetMs);

    const recent = [];
    const seen = new Set();
    if (label && label !== "unknown") {
      recent.push(label);
      seen.add(label);
    }
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (ev && ev.ts && ev.ts >= effectiveStartMs - 60_000) {
        const l = ev.label || ev.app;
        if (l && !seen.has(l)) {
          seen.add(l);
          recent.push(l);
        }
      }
    }
    nextState.recentApps = recent.slice(0, 5);

    if (!nextState.sessionStartedAt) {
      nextState.sessionStartedAt = new Date(effectiveStartMs).toISOString();
      nextState.continuousActiveMs = Math.max(0, nowMs - effectiveStartMs);
    } else {
      nextState.continuousActiveMs = Math.max(0, nowMs - Date.parse(nextState.sessionStartedAt));
    }

    const meetsActiveThreshold = nextState.continuousActiveMs >= this.triggerAfterMs;
    const lastTriggerMs = nextState.lastTriggerAt ? Date.parse(nextState.lastTriggerAt) : null;
    const cooldownElapsed = !Number.isFinite(lastTriggerMs) || (nowMs - lastTriggerMs) >= this.triggerCooldownMs;

    if (meetsActiveThreshold && cooldownElapsed) {
      const triggerText = buildPhoneWatchTriggerText({
        continuousActiveMs: nextState.continuousActiveMs,
        currentApp: nextState.currentApp,
        recentApps: nextState.recentApps,
        lastTriggerAt: nextState.lastTriggerAt,
        nowMs,
      });

      if (this.queueStore && this.target) {
        this.queueStore.enqueue({
          id: crypto.randomUUID(),
          accountId: this.target.accountId,
          senderId: this.target.senderId,
          workspaceRoot: this.target.workspaceRoot,
          text: triggerText,
          createdAt: isoNow,
          source: "phone_watch",
        });
      }

      nextState.lastTriggerAt = isoNow;
      nextState.lastTriggerContinuousMs = nextState.continuousActiveMs;
      this.stateStore.update(nextState);

      return {
        triggered: true,
        continuousActiveMs: nextState.continuousActiveMs,
        currentApp: nextState.currentApp,
        recentApps: nextState.recentApps,
        triggerText,
        legacy: true,
      };
    }

    this.stateStore.update(nextState);
    return {
      triggered: false,
      reason: !meetsActiveThreshold ? "below_threshold" : "in_cooldown",
      continuousActiveMs: nextState.continuousActiveMs,
      legacy: true,
    };
  }

  async sample(nowMs = this.clock()) {
    const sampleData = await this.activitySource.getActivity();
    return this.evaluateSample(sampleData, nowMs);
  }
}

function resolvePollerTarget({ config, account, sessionStore }) {
  const senderId = resolvePreferredSenderId({
    config,
    accountId: account.accountId,
    explicitUser: process.env.CYBERBOSS_CHECKIN_USER_ID || "",
    sessionStore,
  });
  const workspaceRoot = resolvePreferredWorkspaceRoot({
    config,
    accountId: account.accountId,
    senderId,
    explicitWorkspace: process.env.CYBERBOSS_CHECKIN_WORKSPACE || "",
    sessionStore,
  });

  if (!senderId) {
    throw new Error("Cannot determine the WeChat user for phone activity watcher.");
  }
  if (!workspaceRoot) {
    throw new Error("Cannot determine the workspace for phone activity watcher.");
  }

  return { accountId: account.accountId, senderId, workspaceRoot };
}

function formatSystemLocalTime(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(parsed)).replace(/\//g, "-");
}

function buildPhoneWatchTriggerText({
  continuousActiveMs,
  currentApp,
  recentApps = [],
  lastTriggerAt = null,
  nowMs = Date.now(),
}) {
  const activeMinutes = Math.max(1, Math.round(continuousActiveMs / 60_000));
  const observedAtIso = new Date(nowMs).toISOString();
  const localTime = formatSystemLocalTime(observedAtIso);

  let lastTriggerText = "None (first trigger in this session)";
  if (lastTriggerAt) {
    const lastTriggerMs = Date.parse(lastTriggerAt);
    if (Number.isFinite(lastTriggerMs)) {
      const agoMinutes = Math.max(1, Math.round((nowMs - lastTriggerMs) / 60_000));
      lastTriggerText = `${agoMinutes} minutes ago`;
    }
  }

  const recentAppsText = recentApps.length > 0 ? recentApps.join(", ") : currentApp || "unknown";

  return [
    "[Phone activity awareness]",
    `Observed at: ${observedAtIso} (${localTime} Asia/Shanghai)`,
    `Continuous active duration: about ${activeMinutes} minutes.`,
    `Current foreground app: ${currentApp || "unknown"}`,
    `Recent apps: ${recentAppsText}`,
    `Last phone-watch trigger: ${lastTriggerText}`,
    "",
    "This is a background awareness event, not an instruction to message the user.",
    "Use the current time, existing context, and available tools if useful.",
    "Decide naturally whether to stay silent or send a message.",
  ].join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPhoneActivityWatcher(config) {
  const watcher = new PhoneActivityWatcher({ config });
  console.log(`[phone-watch] ready user=${watcher.target.senderId} workspace=${watcher.target.workspaceRoot}`);
  console.log(`[phone-watch] interval=${Math.round(watcher.intervalMs / 60_000)}m triggerAfter=${Math.round(watcher.triggerAfterMs / 60_000)}m cooldown=${Math.round(watcher.triggerCooldownMs / 60_000)}m`);

  while (true) {
    await sleep(watcher.intervalMs);
    try {
      const result = await watcher.sample();
      if (result.triggered) {
        console.log(`[phone-watch] trigger queued active=${Math.round(result.continuousActiveMs / 60_000)}m app=${result.currentApp}`);
      } else {
        // concise debug log
        // [phone-watch] sampled ... no trigger
      }
    } catch (error) {
      console.warn(`[phone-watch] sample failed: ${error.message}`);
    }
  }
}

module.exports = {
  PhoneActivityWatcher,
  buildPhoneWatchTriggerText,
  runPhoneActivityWatcher,
  formatSystemLocalTime,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TRIGGER_AFTER_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_INACTIVE_RESET_MS,
  DEFAULT_HEARTBEAT_STALE_MS,
};
