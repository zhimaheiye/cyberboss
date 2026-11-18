const path = require('path');
const { CodexRpcClient } = require('../adapters/runtime/codex/rpc-client');

const DAY = 86400000;
const KEEP_DAYS = 7;
const validId = id => /^[a-f0-9-]{36}$/i.test(id || '');
const timestamp = value => Date.parse(value) || 0;

class ThreadMaintenance {
  constructor(app) { this.app = app; this.busy = false; }
  get data() {
    return this.app.store.data.threadMaintenance ||= { threads: {}, history: [] };
  }
  register(id, key, at) {
    if (!validId(id)) return;
    const record = this.data.threads[id] ||= { id, key, firstSeenAt: new Date().toISOString() };
    if (key && key !== 'legacy') record.key = key;
    if (timestamp(at) > timestamp(record.lastActivityAt)) record.lastActivityAt = at;
    return record;
  }
  // Ownership comes only from workbench IDs, never sidebar titles or directory matches.
  discover() {
    const d = this.app.store.data;
    this.register(d.threadId, 'legacy');
    for (const run of d.runs) this.register(run.threadId || d.threadId, run.threadId
      ? run.jobId ? `job:${run.jobId}` : run.background ? 'checkin' : 'chat' : 'legacy', run.finishedAt || run.createdAt);
    for (const [key, id] of Object.entries(d.sessionThreads || {})) this.register(id, key);
  }
  name(record) {
    if (record.key === 'chat') return 'CyberBoss · 主对话';
    if (record.key === 'checkin') return 'CyberBoss · 自然唤醒';
    if (record.key?.startsWith('job:')) {
      const job = this.app.store.data.jobs.find(j => `job:${j.id}` === record.key);
      return `CyberBoss · ${job?.title || '已移除任务'}`.slice(0, 160);
    }
    return 'CyberBoss · 历史会话';
  }
  reusable(id) {
    const d = this.app.store.data;
    return Object.entries(d.sessionThreads || {}).some(([key, value]) => {
      if (value !== id) return false;
      if (!key.startsWith('job:')) return true;
      const job = d.jobs.find(j => `job:${j.id}` === key);
      // Paused, blocked and draft jobs can resume with their original context.
      return job && job.status !== 'done';
    });
  }
  view() {
    const d = this.data, records = Object.values(d.threads);
    return { keepDays: KEEP_DAYS, busy: this.busy, lastCheckedAt: d.lastCheckedAt,
      nextCheckAt: d.lastCheckedAt ? new Date(timestamp(d.lastCheckedAt) + DAY).toISOString() : null,
      tracked: records.length, archived: records.filter(r => r.archivedAt).length,
      errors: records.filter(r => r.error).map(r => ({ id: r.id, name: this.name(r), error: r.error })),
      error: d.error || '', history: d.history };
  }
  async prepare(rpc, id, key) {
    const record = this.register(id, key);
    if (!record) return;
    if (record.archivedAt) {
      await rpc.sendRequest('thread/unarchive', { threadId: id });
      delete record.archivedAt;
    }
    record.lastActivityAt = new Date().toISOString();
    this.app.store.save();
  }
  async nameThread(rpc, record) {
    const name = this.name(record);
    if (record.appliedName === name) return;
    await rpc.sendRequest('thread/name/set', { threadId: record.id, name });
    record.appliedName = name;
  }
  async finished(rpc, id) {
    const record = this.data.threads[id];
    if (!record) return;
    record.lastActivityAt = new Date().toISOString();
    try { if (rpc?.isTransportReady()) { await this.nameThread(rpc, record); delete record.error; } }
    catch (error) { record.error = `命名失败：${error.message}`; }
    this.app.store.save();
  }
  async tick(now = Date.now()) {
    const app = this.app, d = this.data;
    if (this.busy || app.stopped || app.agent.active || app.pumping || app.queue.hasPendingForAccount('desktop')
      || d.lastCheckedAt && now - timestamp(d.lastCheckedAt) < DAY) return;
    this.busy = true;
    const rpc = new CodexRpcClient({ codexCommand: app.config.codexCommand });
    this.rpc = rpc;
    const summary = { at: new Date(now).toISOString(), renamed: 0, archived: 0, failed: 0 };
    try {
      this.discover(); app.store.save();
      const records = Object.values(d.threads).filter(r => !r.archivedAt);
      if (records.length) { await rpc.connect(); await rpc.initialize(); }
      for (const record of records) {
        // Yield between records to queued user work; resume maintenance at the next idle tick.
        if (app.stopped || app.queue.hasPendingForAccount('desktop')) return;
        try {
          const thread = (await rpc.sendRequest('thread/read', { threadId: record.id, includeTurns: false })).result?.thread;
          if (!thread || thread.id !== record.id) throw new Error('Codex 未返回该会话的元数据');
          if (thread.status?.type === 'active') continue;
          if (thread.path && path.basename(path.dirname(thread.path)) === 'archived_sessions') {
            record.archivedAt = new Date().toISOString(); delete record.error; app.store.save(); continue;
          }
          const lastActivity = Math.max(timestamp(record.lastActivityAt), Number(thread.updatedAt) * 1000);
          // Re-read local task state after the asynchronous metadata request.
          if (!this.reusable(record.id) && Number.isFinite(lastActivity) && lastActivity > 0
            && now - lastActivity >= KEEP_DAYS * DAY && !app.queue.hasPendingForAccount('desktop') && !app.stopped) {
            await rpc.sendRequest('thread/archive', { threadId: record.id });
            record.archivedAt = new Date().toISOString(); summary.archived++;
          } else {
            const before = record.appliedName;
            await this.nameThread(rpc, record);
            if (before !== record.appliedName) summary.renamed++;
          }
          delete record.error;
        } catch (error) { record.error = error.message; summary.failed++; }
        app.store.save();
      }
      d.lastCheckedAt = summary.at; d.error = '';
    } catch (error) { d.error = error.message; d.lastCheckedAt = summary.at; }
    finally {
      d.history = [...d.history, summary].slice(-30);
      await rpc.close(); this.rpc = null; this.busy = false;
      app.store.save(); app.changed();
      if (!app.stopped) void app.pump();
    }
  }
  async close() { await this.rpc?.close(); }
}

module.exports = { ThreadMaintenance };
