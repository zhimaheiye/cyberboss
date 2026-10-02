const fs = require("fs");
const path = require("path");

function createEmptyPhoneWatchState() {
  return {
    sessionStartedAt: null,
    lastActiveAt: null,
    lastSampleAt: null,
    currentApp: "",
    recentApps: [],
    continuousActiveMs: 0,
    lastTriggerAt: null,
    lastTriggerContinuousMs: null,
    lastResetAt: null,
  };
}

class PhoneWatchStateStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = createEmptyPhoneWatchState();
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    }
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      this.state = createEmptyPhoneWatchState();
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = normalizePhoneWatchState(parsed);
    } catch {
      this.state = createEmptyPhoneWatchState();
    }
  }

  save() {
    if (!this.filePath) {
      return;
    }
    const serialized = JSON.stringify(this.state, null, 2);
    const tempPath = `${this.filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    try {
      fs.writeFileSync(tempPath, serialized, "utf8");
      fs.renameSync(tempPath, this.filePath);
    } catch {
      try {
        fs.writeFileSync(this.filePath, serialized, "utf8");
      } catch {
        // ignore write failure
      }
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // ignore cleanup error
      }
    }
  }

  getState() {
    return {
      ...this.state,
      recentApps: Array.isArray(this.state.recentApps) ? [...this.state.recentApps] : [],
    };
  }

  update(patch = {}) {
    this.state = normalizePhoneWatchState({
      ...this.state,
      ...patch,
    });
    this.save();
    return this.getState();
  }

  resetSession(nowMs = Date.now(), reason = "") {
    const isoNow = new Date(nowMs).toISOString();
    return this.update({
      sessionStartedAt: null,
      continuousActiveMs: 0,
      lastResetAt: isoNow,
    });
  }
}

function normalizePhoneWatchState(value) {
  if (!value || typeof value !== "object") {
    return createEmptyPhoneWatchState();
  }

  return {
    sessionStartedAt: normalizeIso(value.sessionStartedAt),
    lastActiveAt: normalizeIso(value.lastActiveAt),
    lastSampleAt: normalizeIso(value.lastSampleAt),
    currentApp: typeof value.currentApp === "string" ? value.currentApp.trim() : "",
    recentApps: normalizeRecentApps(value.recentApps),
    continuousActiveMs: Number.isFinite(value.continuousActiveMs) && value.continuousActiveMs >= 0 ? Math.floor(value.continuousActiveMs) : 0,
    lastTriggerAt: normalizeIso(value.lastTriggerAt),
    lastTriggerContinuousMs: Number.isFinite(value.lastTriggerContinuousMs) && value.lastTriggerContinuousMs >= 0 ? Math.floor(value.lastTriggerContinuousMs) : null,
    lastResetAt: normalizeIso(value.lastResetAt),
  };
}

function normalizeIso(val) {
  if (typeof val !== "string" || !val.trim()) {
    return null;
  }
  const parsed = Date.parse(val);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeRecentApps(val) {
  if (!Array.isArray(val)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const item of val) {
    if (typeof item === "string" && item.trim()) {
      const trimmed = item.trim();
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
  }
  return result;
}

module.exports = {
  PhoneWatchStateStore,
  createEmptyPhoneWatchState,
  normalizePhoneWatchState,
};
