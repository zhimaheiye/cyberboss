const fs = require("fs");
const path = require("path");

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_MIN_INACTIVE_MINUTES = 360; // 6 hours sleep gap

function createDefaultRules() {
  return [
    {
      id: "wake-followup-learn",
      type: "wake_followup",
      enabled: true,
      delayMinutes: 60,
      reminderText: "醒来一小时到啦，该开始学习啦～",
      lastTriggeredAt: null,
      lastTriggeredLocalDate: null,
      config: {
        minInactiveMinutes: DEFAULT_MIN_INACTIVE_MINUTES,
      },
    },
    {
      id: "bedtime-daily",
      type: "daily_time",
      enabled: false,
      localTime: null,
      reminderText: "该准备休息睡觉啦～",
      lastTriggeredLocalDate: null,
    },
  ];
}

class PersistentRuleStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { rules: [] };
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
      this.state = { rules: createDefaultRules() };
      this.save();
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rules)) {
        console.warn(`[persistent-rule-store] invalid format in ${this.filePath}, preserving defaults`);
        if (!this.state.rules || this.state.rules.length === 0) {
          this.state = { rules: createDefaultRules() };
        }
        return;
      }
      this.state = {
        rules: parsed.rules.map(normalizeRule).filter(Boolean),
      };
    } catch (error) {
      console.warn(`[persistent-rule-store] malformed JSON in ${this.filePath}: ${error.message}`);
      if (!this.state.rules || this.state.rules.length === 0) {
        this.state = { rules: createDefaultRules() };
      }
    }
  }

  save() {
    if (!this.filePath) {
      return;
    }
    this.ensureParentDirectory();
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

  getRules() {
    return Array.isArray(this.state.rules) ? [...this.state.rules] : [];
  }

  getRule(id) {
    const normalizedId = typeof id === "string" ? id.trim() : "";
    if (!normalizedId) {
      return null;
    }
    return this.state.rules.find((rule) => rule.id === normalizedId) || null;
  }

  updateRule(id, patch = {}) {
    const normalizedId = typeof id === "string" ? id.trim() : "";
    if (!normalizedId) {
      return null;
    }
    const index = this.state.rules.findIndex((rule) => rule.id === normalizedId);
    if (index < 0) {
      return null;
    }
    const current = this.state.rules[index];
    const updated = normalizeRule({
      ...current,
      ...patch,
      id: current.id,
      config: {
        ...(current.config || {}),
        ...(patch.config || {}),
      },
    });
    this.state.rules[index] = updated;
    this.save();
    return updated;
  }

  recordTrigger(id, { triggeredAt = new Date().toISOString(), localDate = "" } = {}) {
    return this.updateRule(id, {
      lastTriggeredAt: triggeredAt,
      lastTriggeredLocalDate: localDate,
    });
  }
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== "object") {
    return null;
  }
  const id = typeof rule.id === "string" ? rule.id.trim() : "";
  if (!id) {
    return null;
  }

  return {
    ...rule,
    id,
    type: typeof rule.type === "string" ? rule.type.trim() : "unknown",
    enabled: typeof rule.enabled === "boolean" ? rule.enabled : false,
    delayMinutes: Number.isFinite(rule.delayMinutes) ? rule.delayMinutes : undefined,
    localTime: typeof rule.localTime === "string" ? rule.localTime.trim() : (rule.localTime === null ? null : undefined),
    timezone: typeof rule.timezone === "string" && rule.timezone.trim() ? rule.timezone.trim() : DEFAULT_TIMEZONE,
    reminderText: typeof rule.reminderText === "string" ? rule.reminderText : (rule.reminderText === null ? null : ""),
    lastTriggeredAt: typeof rule.lastTriggeredAt === "string" ? rule.lastTriggeredAt : null,
    lastTriggeredLocalDate: typeof rule.lastTriggeredLocalDate === "string" ? rule.lastTriggeredLocalDate : null,
    config: rule.config && typeof rule.config === "object" ? { ...rule.config } : {},
  };
}

function formatLocalDate(ts = Date.now(), timeZone = DEFAULT_TIMEZONE) {
  const d = new Date(ts);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function formatLocalTime(ts = Date.now(), timeZone = DEFAULT_TIMEZONE) {
  const d = new Date(ts);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

module.exports = {
  PersistentRuleStore,
  createDefaultRules,
  formatLocalDate,
  formatLocalTime,
  DEFAULT_TIMEZONE,
  DEFAULT_MIN_INACTIVE_MINUTES,
};
