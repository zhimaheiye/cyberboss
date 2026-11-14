const LEASE_MS = 150_000;
const DURATIONS = [1, 2, 5, null];
const PACES = [3, 4, 5];
const FEEDBACK = ["better", "same", "worse"];

class Breathing {
  constructor(store, changed) {
    this.store = store;
    this.changed = changed;
    this.data = store.data.breathing ||= { current: null, records: [] };
    if (this.data.current) this.complete(this.data.current, "interrupted");
  }

  current() {
    const session = this.data.current;
    if (session && session.expiresAt <= Date.now()) {
      this.complete(session, "interrupted", session.expiresAt);
      return null;
    }
    return session;
  }

  complete(session, outcome, endedAt = Date.now()) {
    const { id, startedAt, activeMs, minutes, pace } = session;
    const record = { id, startedAt, endedAt, activeMs, minutes, pace, outcome };
    this.data.current = null;
    this.data.records.push(record);
    this.store.save();
    this.changed();
    return record;
  }

  view() {
    const active = Boolean(this.current());
    return { active, reminderCount: this.reminders().messages.length, recent: this.data.records.slice(-10).reverse() };
  }

  reminders() {
    const ids = new Set(this.data.records.filter(r => !r.summaryDismissed).map(r => r.id));
    const messages = this.store.data.messages.filter(m => m.unread && ids.has(m.breathingSessionId));
    return { sessions: [...new Set(messages.map(m => m.breathingSessionId))],
      messages: messages.map(({ id, kind, createdAt, text }) => ({ id, kind, createdAt, text })) };
  }

  update(body) {
    const { action, id } = body;
    const current = this.current();
    if (action === "dismiss") {
      const sessions = new Set(Array.isArray(body.sessions) ? body.sessions : []);
      for (const record of this.data.records) {
        if (sessions.has(record.id)) record.summaryDismissed = true;
      }
      this.store.save();
      return { dismissed: true };
    }
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("练习编号无效");
    const previous = this.data.records.find(record => record.id === id);
    if (action === "feedback") {
      if (!previous || !FEEDBACK.includes(body.feedback)) throw new Error("练习反馈无效");
      previous.feedback = body.feedback;
      this.store.save();
      return previous;
    }
    if (action === "finish" && previous) return previous;
    if (!["start", "progress", "finish"].includes(action)) throw new Error("未知练习操作");
    if (action === "start") {
      if (current?.id === id) return { active: true };
      if (current) throw new Error("另一个工作台页面正在练习");
      if (previous) throw new Error("这次练习已结束");
    } else if (current?.id !== id) {
      if (action === "finish") return null;
      throw new Error("这次练习已结束");
    }
    const now = Date.now();
    const session = current || { id, startedAt: now, activeMs: 0 };
    if (DURATIONS.includes(body.minutes)) session.minutes = body.minutes;
    if (PACES.includes(body.pace)) session.pace = body.pace;
    session.minutes = session.minutes === undefined ? 2 : session.minutes;
    session.pace ||= 4;
    if (Number.isFinite(body.activeMs)) {
      session.activeMs = Math.max(session.activeMs, Math.min(Math.round(body.activeMs), now - session.startedAt));
    }
    if (action === "finish") return this.complete(session, body.outcome === "completed" ? "completed" : "stopped");
    session.expiresAt = now + LEASE_MS;
    this.data.current = session;
    this.store.save();
    return { active: true };
  }
}

module.exports = { Breathing };
