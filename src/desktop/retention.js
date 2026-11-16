const { observationKind } = require('./observations');
const DAY = 86400000;
const ref = (type, id) => `${type}:${encodeURIComponent(id)}`;

class Retention {
  constructor(app) { this.app = app; }
  data() { return { enabled: true, keepDays: 7, history: [], ...this.app.store.data.retention }; }
  view() {
    const data = this.data();
    return { ...data, nextCheckAt: data.enabled ? data.requestedAt || (data.lastCheckedAt
      ? new Date(Date.parse(data.lastCheckedAt) + DAY).toISOString() : null) : null };
  }
  configure(input) {
    const days = Number(input.keepDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('保留天数需为 1～365 的整数');
    this.app.store.data.retention = { ...this.data(), enabled: input.enabled === true, keepDays: days,
      requestedAt: input.enabled === true ? new Date().toISOString() : null };
    this.app.store.save(); this.app.changed(); return this.view();
  }
  request() {
    if (!this.data().enabled) return { queued: false, reason: '自动清理已关闭' };
    this.app.store.data.retention = { ...this.data(), requestedAt: new Date().toISOString() };
    this.app.store.save(); this.app.changed(); return { queued: true, message: '已安排在工作台空闲时按保存的保留策略检查' };
  }
  plan(now = Date.now()) {
    const app = this.app, d = app.store.data, policy = this.data(), cutoff = now - policy.keepDays * DAY;
    const runs = d.runs, byId = new Map(runs.map(r => [r.id, r])), jobs = new Map(d.jobs.map(j => [j.id, j]));
    const protectedRuns = new Set(), protectedRefs = new Set(), latest = new Map();
    for (const r of runs) {
      const key = r.jobId || (r.background ? 'checkin' : 'chat');
      if (!latest.has(key) || Date.parse(r.createdAt) >= Date.parse(latest.get(key).createdAt)) latest.set(key, r);
    }
    for (const r of latest.values()) protectedRuns.add(r.id);
    for (const skill of Object.values(d.learnedSkills || {})) for (const version of skill.versions || []) protectedRuns.add(version.sourceRunId);
    for (const item of [...(d.taskEvents || []), ...d.messages]) if (item.runId) protectedRuns.add(item.runId);
    for (const job of d.jobs) if (job.blocker?.sourceRunId) protectedRuns.add(job.blocker.sourceRunId);
    for (const link of app.toolbox.load().links) {
      protectedRefs.add(link.fromRef); protectedRefs.add(link.toRef);
      for (const entry of link.history || []) if (entry.runId) protectedRuns.add(entry.runId);
    }
    // Legacy observations have no runId. Associate only a unique containing
    // background run by the write timestamp; never infer success from text.
    const observationRuns = new Map();
    for (const observation of d.observations) {
      let id = observation.runId;
      if (!id && observationKind(observation) === 'execution') {
        const at = Date.parse(observation.createdAt);
        const matches = runs.filter(r => r.background && Date.parse(r.createdAt) <= at && Date.parse(r.finishedAt) >= at);
        if (matches.length === 1) id = matches[0].id;
      }
      if (id && byId.has(id)) {
        observationRuns.set(observation.id, id);
        if (observationKind(observation) !== 'execution' || observation.evidence === 'user' || observation.actor === 'user'
          || protectedRefs.has(ref('event', observation.id)) || !(Date.parse(observation.createdAt) < cutoff)) protectedRuns.add(id);
      }
    }
    const removable = runs.filter(r => {
      const job = jobs.get(r.jobId);
      const recurring = r.jobId ? job && ['watch', 'operation'].includes(job.kind) && job.schedule?.type === 'recurring'
        && job.status !== 'blocked' && !job.lastError : String(r.queueId || '').startsWith('checkin@');
      return recurring && r.background === true && r.status === 'completed' && r.action === 'silent'
        && !r.error && !r.learningError && !r.note && !r.cancelRequested && !r.omittedSteps
        && r.learningOutcome !== 'uncertain' && Date.parse(r.finishedAt) < cutoff
        && !protectedRuns.has(r.id) && !protectedRefs.has(ref('run', r.id))
        && (r.steps || []).every(step => ['completed', 'succeeded'].includes(step.status) && !step.error && (step.exitCode == null || step.exitCode === 0));
    });
    const runIds = new Set(removable.map(r => r.id));
    const observations = d.observations.filter(o => runIds.has(observationRuns.get(o.id)));
    const refs = new Set([...removable.map(r => ref('run', r.id)), ...observations.map(o => ref('event', o.id))]);
    const byJob = new Map();
    for (const r of removable) {
      const key = r.jobId || 'checkin', item = byJob.get(key) || { jobId: r.jobId || null, runs: 0, firstAt: r.createdAt, lastAt: r.finishedAt };
      item.runs++; if (r.createdAt < item.firstAt) item.firstAt = r.createdAt; if (r.finishedAt > item.lastAt) item.lastAt = r.finishedAt;
      byJob.set(key, item);
    }
    return { runIds, observationIds: new Set(observations.map(o => o.id)), refs,
      summary: { runs: removable.length, observations: observations.length,
        vectors: Object.values(app.retrieval.index.rows).filter(row => refs.has(row.ref)).length,
        byJob: [...byJob.values()], cutoff: new Date(cutoff).toISOString() } };
  }
  tick(now = Date.now()) {
    const app = this.app, policy = this.data();
    if (!policy.enabled || !policy.requestedAt && policy.lastCheckedAt && now - Date.parse(policy.lastCheckedAt) < DAY) return;
    // Run only on the workbench's idle loop. In-flight indexing could otherwise
    // write a stale snapshot back after pruning.
    if (app.agent.active || app.pumping || app.retrieval.progress.busy || app.queue.hasPendingForAccount('desktop')) return;
    const d = app.store.data, oldRuns = d.runs, oldObservations = d.observations, oldPolicy = d.retention;
    try {
      const plan = this.plan(now), at = new Date(now).toISOString();
      // Prune derived data first. If saving originals fails, their arrays are
      // restored; missing vectors can be recreated by normal indexing.
      const vectors = app.retrieval.removeRefs(plan.refs);
      d.runs = d.runs.filter(r => !plan.runIds.has(r.id));
      d.observations = d.observations.filter(o => !plan.observationIds.has(o.id));
      const summary = { ...plan.summary, vectors, at };
      d.retention = { ...policy, lastCheckedAt: at, requestedAt: null, error: '',
        ...(summary.runs ? { lastCleanupAt: at, lastSummary: summary,
          history: [...policy.history, summary].slice(-30),
          totals: { runs: (policy.totals?.runs || 0) + summary.runs,
            observations: (policy.totals?.observations || 0) + summary.observations,
            vectors: (policy.totals?.vectors || 0) + vectors } } : {}) };
      app.store.save(); app.changed();
    } catch (error) {
      d.runs = oldRuns; d.observations = oldObservations; d.retention = oldPolicy;
      d.retention = { ...policy, lastCheckedAt: new Date(now).toISOString(), requestedAt: null, error: error.message };
      try { app.store.save(); } catch { /* Keep original records in memory and retry on the next daily check. */ }
      app.changed();
    }
  }
  invoke(args) {
    if (args.action === 'status') return this.view();
    if (args.action === 'preview') return this.plan().summary;
    if (args.action === 'request') return this.request();
    throw new Error('未知清理操作');
  }
}
module.exports = { Retention };
