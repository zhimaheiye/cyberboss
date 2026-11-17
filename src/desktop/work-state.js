const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { currentRun } = require('./run-context');
const { hash } = require('./search-sources');
const now = () => new Date().toISOString();
const text = (value, max = 6000) => String(value || '').trim().slice(0, max);
class WorkState {
  constructor(app) {
    this.app = app; this.store = app.store;
    this.store.data.workStates ||= {};
    this.store.data.workEvents ||= [];
    this.store.data.workSubscriptions ||= [];
    for (const e of this.store.data.workEvents) {
      if (e.delivery !== 'delivered' || e.outcome) continue;
      const run = this.store.data.runs.find(r => r.id === e.runId);
      if (run && run.status !== 'running') e.outcome = run.status;
    }
    for (const [id, state] of Object.entries(this.store.data.workStates)) {
      const run = this.store.data.runs.findLast(r => r.jobId === id);
      if (run && ['interrupted', 'incomplete'].includes(run.status) && (state.lastRunId !== run.id || state.lastRunStatus !== run.status)) this.finish(run);
    }
  }
  job(id) { const job = this.store.data.jobs.find(j => j.id === id); if (!job) throw new Error('托管事项不存在'); return job; }
  state(id) { this.job(id); return this.store.data.workStates[id] || { version: 0, summary: '', facts: [], openQuestions: [], nextStep: '', needsUser: false, waitingFor: '' }; }
  view(id) {
    return { progress: this.state(id), events: this.store.data.workEvents.filter(e => e.jobId === id).slice(-100),
      subscriptions: this.store.data.workSubscriptions.filter(s => s.jobId === id) };
  }
  overview() {
    return Object.fromEntries(this.store.data.jobs.map(j => [j.id, { ...this.state(j.id),
      pendingEvents: this.pending(j.id).length, subscriptionErrors: this.store.data.workSubscriptions.filter(s => s.jobId === j.id && s.enabled && s.error).map(s => s.error) }]));
  }
  report(args) {
    const run = currentRun(this.store);
    if (!run?.jobId || args.jobId && args.jobId !== run.jobId) throw new Error('进展只能写入当前正在执行的托管事项');
    const old = this.state(run.jobId);
    if (Number(args.expectedVersion) !== old.version) throw new Error('进展已变化，请读取后再保存');
    const input = args.progress || {};
    if (!text(input.summary)) throw new Error('请提供简短的当前进展');
    const facts = Array.isArray(input.facts) ? input.facts.slice(0, 50).map(f => ({ text: text(f.text), source: text(f.source, 2000) })).filter(f => f.text) : old.facts;
    const progress = { ...old, summary: text(input.summary), facts,
      openQuestions: Array.isArray(input.openQuestions) ? input.openQuestions.slice(0, 30).map(q => text(q, 2000)).filter(Boolean) : old.openQuestions,
      nextStep: text(input.nextStep), waitingFor: text(input.waitingFor, 2000), needsUser: input.needsUser === true,
      version: old.version + 1, updatedAt: now(), runId: run.id };
    this.store.data.workStates[run.jobId] = progress;
    this.store.add('workEvents', { jobId: run.jobId, kind: 'progress', actor: 'agent', runId: run.id, progress });
    return progress;
  }
  pending(id) { return this.store.data.workEvents.filter(e => e.jobId === id && e.delivery === 'pending'); }
  emit({ jobId, source, key, data }, actor = 'external') {
    if (!text(source, 300) || !text(key, 300)) throw new Error('事件需要稳定的 source 和 key，用于去重');
    source = text(source, 300); key = text(key, 300);
    const payload = JSON.stringify(data ?? null);
    if (payload.length > 20000) throw new Error('事件内容最多 2 万字');
    const ids = jobId ? [this.job(jobId).id] : [...new Set(this.store.data.workSubscriptions.filter(s => s.enabled && s.kind === 'event' && s.target === source).map(s => s.jobId))];
    const result = [];
    for (const id of ids) {
      const duplicate = this.store.data.workEvents.find(e => e.jobId === id && e.source === source && e.key === key);
      if (duplicate) { result.push({ id: duplicate.id, duplicate: true }); continue; }
      result.push(this.store.add('workEvents', { jobId: id, kind: 'input', actor, source: text(source, 300), key: text(key, 300), data: JSON.parse(payload), delivery: 'pending' }));
    }
    this.app.changed(); return result;
  }
  async subscribe(args, actor) {
    this.job(args.jobId);
    const subscriptions = this.store.data.workSubscriptions;
    const old = args.id ? subscriptions.find(s => s.id === args.id && s.jobId === args.jobId) : null;
    if (args.id && !old) throw new Error('订阅不存在');
    if (old && Number(args.version) !== old.version) throw new Error('订阅已变化，请刷新后再保存');
    const kind = args.kind || old?.kind, target = text(args.target || old?.target, 1000);
    if (!['reference', 'file', 'event'].includes(kind) || !target) throw new Error('请选择订阅类型并填写来源');
    if (kind === 'reference' && target === `job:${encodeURIComponent(args.jobId)}`) throw new Error('不能订阅事项自身的进展，以免每次执行再次触发');
    if (kind === 'file' && !path.isAbsolute(target)) throw new Error('请填写单个本地文件的绝对路径');
    const value = { id: old?.id || crypto.randomUUID(), jobId: args.jobId, kind, target,
      enabled: args.enabled !== false, version: (old?.version || 0) + 1, updatedAt: now(), actor,
      condition: text(args.condition === undefined ? old?.condition : args.condition, 2000), ...(old && kind === old.kind && target === old.target ? { fingerprint: old.fingerprint, error: old.error, checkedAt: old.checkedAt } : {}) };
    if (value.enabled && kind !== 'event' && !value.fingerprint) {
      const doc = await this.readSource(value); value.fingerprint = doc.hash; value.checkedAt = now();
    }
    // Reading a source may take time; recheck before replacing a human edit.
    if (actor === 'agent') currentRun(this.store);
    if (old && subscriptions.find(s => s.id === old.id)?.version !== old.version) throw new Error('订阅已变化，请刷新');
    if (old) subscriptions[subscriptions.indexOf(old)] = value; else subscriptions.push(value);
    this.store.save(); this.app.changed(); return value;
  }
  async readSource(s) {
    if (s.kind === 'reference') return this.app.retrieval.sources.read(s.target);
    const stat = await fs.stat(s.target);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('订阅文件须为不超过 1 MB 的文本文件');
    const content = await fs.readFile(s.target, 'utf8');
    if (content.includes('\0')) throw new Error('订阅仅支持文本文件');
    return { hash: hash(content), text: content, title: path.basename(s.target) };
  }
  async tick() {
    if (this.polling || this.app.stopped) return;
    this.polling = true;
    try {
      if (!this.lastPoll || Date.now() - this.lastPoll >= 60000) {
        this.lastPoll = Date.now();
        for (const s of [...this.store.data.workSubscriptions]) {
          if (this.app.stopped) return;
          if (!s.enabled || s.kind === 'event' || this.job(s.jobId).status === 'done') continue;
          try {
            const doc = await this.readSource(s);
            if (this.app.stopped) return;
            if (!this.store.data.workSubscriptions.includes(s)) continue;
            if (s.fingerprint && s.fingerprint !== doc.hash) this.emit({ jobId: s.jobId, source: `subscription:${s.id}`,
              key: crypto.randomUUID(), data: { source: s.target, title: doc.title, previousHash: s.fingerprint,
                hash: doc.hash, excerpt: doc.text.slice(0, 12000), condition: s.condition } }, 'source');
            s.fingerprint = doc.hash; s.error = ''; s.checkedAt = now();
          } catch (error) { s.error = `${s.target}：${error.message}`; s.checkedAt = now(); }
        }
        this.store.save(); this.app.changed();
      }
      for (const job of this.store.data.jobs) {
        if (this.app.stopped) return;
        const pending = this.pending(job.id);
        if (!pending.length || job.status !== 'active') continue;
        if (job.verificationRetry?.at && Date.parse(job.verificationRetry.at) > Date.now()) continue;
        try {
          const result = this.app.runJob(job.id, pending[0]);
          if (job.kind === 'reminder' && result.notified) {
            for (const e of pending) { e.delivery = 'delivered'; e.deliveredAt = now(); e.outcome = 'notified'; e.runId = result.runId || null; }
            this.store.save(); this.app.changed();
          }
        } catch { /* Time windows and explicit suppression remain authoritative. */ }
      }
    } finally { this.polling = false; }
  }
  take(run) {
    if (!run.jobId) return;
    const events = this.pending(run.jobId).slice(0, 20);
    run.inputEvents = events.map(e => ({ id: e.id, actor: e.actor, source: e.source, data: e.data, createdAt: e.createdAt }));
    for (const e of events) { e.delivery = 'delivered'; e.runId = run.id; e.deliveredAt = now(); }
    this.store.save();
  }
  finish(run) {
    if (!run.jobId) return;
    for (const e of this.store.data.workEvents.filter(e => e.runId === run.id && e.kind === 'input')) e.outcome = run.status;
    const old = this.state(run.jobId);
    this.store.data.workStates[run.jobId] = { ...old, lastRunId: run.id, lastRunAt: run.finishedAt || run.updatedAt || run.createdAt, lastRunStatus: run.status,
      notificationDecision: run.notificationDecision || null, retryAt: run.retryAt || null,
      lastVerification: run.verification || null, lastAttempts: (run.checkAttempts || []).slice(-12),
      lastError: run.status !== 'completed' ? run.error || run.note || '' : '' };
  }
  async invoke(args, actor = 'agent') {
    const id = args.jobId || (actor === 'agent' ? currentRun(this.store)?.jobId : null);
    if (args.action === 'read') return this.view(id);
    if (args.action === 'report') { if (actor !== 'agent') throw new Error('进展由执行过程记录；补充说明请使用输入框'); return this.report({ ...args, jobId: id }); }
    if (args.action === 'subscribe') return this.subscribe({ ...args, jobId: id }, actor);
    if (args.action === 'input') {
      if (actor !== 'user') throw new Error('人工补充只能通过工作台提交；Agent 请使用 report 或 emit');
      if (!text(args.text)) throw new Error('请填写补充内容');
      return this.emit({ jobId: id, source: 'user', key: args.key || crypto.randomUUID(), data: { text: text(args.text) } }, 'user');
    }
    if (args.action === 'emit') return this.emit(args, actor);
    throw new Error('未知进展或事件操作');
  }
}
module.exports = { WorkState };
