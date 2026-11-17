const { preview } = require('./run-progress');

// Persist observations, not private reasoning. A tool transport completing is not a check result.
function recordAttempt(store, args) {
  const run = require('./run-context').currentRun(store);
  if (!run?.background || !run.jobId) throw new Error('核验记录只能写入当前后台作业');
  if (!['succeeded', 'failed', 'inconclusive'].includes(args.status)
    || !args.method?.trim() || !args.target?.trim() || !args.detail?.trim()) {
    throw new Error('请提供 method、target、status 和具体 detail');
  }
  run.checkAttempts ||= [];
  if (run.checkAttempts.length >= 80) throw new Error('本轮核验记录已达上限，请结束本轮并保留未完成原因');
  const attempt = { id: `check-${run.checkAttempts.length + 1}`, at: new Date().toISOString(),
    method: preview(args.method, 200), target: preview(args.target, 1000), status: args.status,
    detail: preview(args.detail, 4000) };
  run.checkAttempts.push(attempt); run.updatedAt = attempt.at; store.save();
  return attempt;
}

function assessVerification(run, job, action) {
  const input = action.verification || {};
  const required = job?.kind === 'watch' || action.action === 'retry' || input.status === 'incomplete';
  if (!required) return null;
  const evidence = Array.isArray(input.evidence) ? input.evidence.filter(e => typeof e === 'string' && e.trim()).slice(0, 20).map(e => preview(e, 2000)) : [];
  const summary = typeof input.summary === 'string' ? preview(input.summary.trim(), 4000) : '';
  const recovery = typeof input.recovery === 'string' ? preview(input.recovery.trim(), 4000) : '';
  const failures = [...(run.steps || []), ...(run.toolDetails || [])].filter(s => s.error || ['failed', 'interrupted', 'unknown'].includes(s.status));
  const unsuccessful = (run.checkAttempts || []).filter(a => a.status !== 'succeeded');
  const succeeded = (run.checkAttempts || []).some(a => a.status === 'succeeded');
  let reason = '';
  if (action.action === 'retry' || input.status === 'incomplete') reason = summary || 'Agent 报告核验未完成';
  else if (input.status !== 'complete' || !summary || !evidence.length) reason = '未提交完整的核验结论与来源，无法确认本次查询已完成';
  else if (!succeeded) reason = '缺少本轮成功读取来源的核查记录，无法确认查询完成';
  else if (action.learningOutcome === 'uncertain') reason = summary || 'Agent 报告结果不确定';
  else if ((failures.length || unsuccessful.length) && !recovery) reason = '查询存在失败或未确认的步骤，未记录替代渠道的核验结果';
  return { status: reason ? 'incomplete' : 'complete', summary: reason || summary, evidence, recovery,
    failureCount: failures.length + unsuccessful.length, recordedAt: new Date().toISOString() };
}

function deferVerification(job, run) {
  run.status = 'incomplete'; run.action = 'retry'; run.learningOutcome = 'uncertain';
  run.note = run.verification.summary;
  // Only read-only monitoring is retried automatically. Other jobs may have side effects.
  if (job?.kind !== 'watch' || job.status !== 'active') return;
  const attempt = (job.verificationRetry?.attempt || 0) + 1;
  const delay = [15, 60, 180, 360][Math.min(attempt - 1, 3)];
  const at = new Date(Date.now() + delay * 60000).toISOString();
  job.verificationRetry = { attempt, at, sourceRunId: run.id, reason: run.note };
  job.version++;
  run.retryAt = at;
}

module.exports = { recordAttempt, assessVerification, deferVerification };
