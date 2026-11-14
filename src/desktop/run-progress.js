const TRACKED = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch']);
const LIMIT = 6000;
function redact(text) {
  return String(text ?? '').replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[图片数据省略]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[已隐藏]')
    .replace(/(["']?(?:apiToken|token|api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|cookie|secret)["']?\s*[:=]\s*)(["'])(.*?)\2/gi, '$1$2[已隐藏]$2')
    .replace(/(^|\n)(\s*(?:Authorization|Cookie|Set-Cookie):)[^\n]*/gi, '$1$2 [已隐藏]');
}
function preview(value, limit = LIMIT) {
  let text;
  if (typeof value === 'string') text = value;
  else text = JSON.stringify(value, (key, val) => /^(token|apiToken|api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|cookie|secret)$/i.test(key) ? '[已隐藏]' : typeof val === 'string' ? redact(val) : val, 2) || '';
  text = redact(text); return text.length > limit ? text.slice(0, limit) + '\n…（内容已截断）' : text;
}
function resultError(value) {
  if (!value) return '';
  if (value.isError === true || value.ok === false || value.success === false) return preview(value.error || value.content || value.message || value, 1200);
  const parts = value.content || (Array.isArray(value) ? value : []);
  for (const part of parts) {
    if (!part?.text) continue;
    // A shell transport may succeed while the service's JSON body says ok:false.
    for (const line of part.text.split('\n')) {
      try { const parsed = JSON.parse(line); if (parsed?.ok === false || parsed?.isError === true || parsed?.success === false) return preview(parsed.error || parsed, 1200); } catch {}
    }
  }
  return '';
}
function itemName(item) {
  if (item.type === 'mcpToolCall') return [item.server, item.tool].filter(Boolean).join(' · ');
  if (item.type === 'dynamicToolCall') return item.tool || '工具调用';
  if (item.type === 'fileChange') return '修改文件';
  if (item.type === 'webSearch') return '搜索网页';
  return '执行命令';
}
function itemSummary(item) {
  const args = item.arguments || {};
  if (item.type === 'fileChange') return (item.changes || []).map(change => `${change.kind?.type || change.kind || '修改'} ${change.path}`).join('\n');
  return preview(item.command || args.command || args.file_path || args.path || args.action || args.query || item.action?.query || item.tool || item.type, 350);
}
function touch(run, phase, now) { run.progress = { ...run.progress, phase, lastEventAt: now }; run.updatedAt = now; }
function recordEvent(run, method, p, now = new Date().toISOString()) {
  if (!run) return false;
  const item = p.item;
  if (method?.startsWith('item/reasoning/')) {
    // Activity only. Never persist private reasoning or its summaries.
    touch(run, run.steps?.some(s => s.status === 'running') ? 'tool' : 'model', now); return true;
  }
  if (['item/started', 'item/completed'].includes(method) && TRACKED.has(item?.type)) {
    run.steps ||= [];
    let step = item.id && run.steps.find(s => s.id === item.id);
    if (!step) {
      if (run.steps.length >= 200) { run.steps.shift(); run.omittedSteps = (run.omittedSteps || 0) + 1; }
      step = { id: item.id || `${item.type}-${now}`, at: now, type: item.type };
      run.steps.push(step);
    }
    step.name = itemName(item); step.summary = itemSummary(item);
    step.input = preview(item.arguments || item.command || item.action || item.changes || '');
    if (method === 'item/started') { step.startedAt ||= now; step.status = 'running'; }
    else {
      step.finishedAt = now; step.transportStatus = item.status || 'completed';
      step.error = preview(item.error || resultError(item.result) || '', 1200);
      step.status = step.error || (item.exitCode != null && item.exitCode !== 0) ? 'failed' : item.status || 'completed';
      step.output = preview(item.result ?? item.aggregatedOutput ?? item.contentItems ?? step.output ?? '');
      if (item.exitCode != null) step.exitCode = item.exitCode;
      if (step.startedAt) step.durationMs = Date.parse(now) - Date.parse(step.startedAt);
    }
    touch(run, run.steps.some(s => s.status === 'running') ? 'tool' : 'model', now); return true;
  }
  if (['item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/mcpToolCall/progress'].includes(method)) {
    const step = run.steps?.find(s => s.id === p.itemId);
    if (step) { step.output = preview((step.output || '') + (p.delta || p.message || ''), LIMIT); step.lastOutputAt = now; }
    touch(run, 'tool', now); return true;
  }
  if (method === 'item/agentMessage/delta' || method === 'item/completed' && item?.type === 'agentMessage') {
    run.updates ||= []; const id = p.itemId || item?.id || 'reply';
    let entry = run.updates.find(u => u.id === id);
    if (!entry) { entry = { id, at: now, text: '' }; run.updates.push(entry); if (run.updates.length > 40) run.updates.shift(); }
    entry.text = preview(method === 'item/agentMessage/delta' ? entry.text + (p.delta || '') : item.text, LIMIT);
    entry.phase = item?.phase || entry.phase || 'output'; entry.updatedAt = now;
    touch(run, 'response', now); return true;
  }
  return false;
}
function finishProgress(run, status = 'interrupted') {
  if (!run) return;
  const now = new Date().toISOString();
  for (const step of run.steps || []) if (step.status === 'running') {
    step.status = status; step.finishedAt = now;
    if (step.startedAt) step.durationMs = Date.parse(now) - Date.parse(step.startedAt);
  }
  touch(run, 'finished', now);
}
function runSummary(run) {
  const { updates, ...summary } = run;
  return { ...summary, latestUpdate: updates?.at(-1)?.text?.slice(0, 500),
    steps: run.steps?.map(({ input, output, ...step }) => ({ ...step, hasDetails: !!(input || output) })) };
}
module.exports = { recordEvent, finishProgress, runSummary, preview };
