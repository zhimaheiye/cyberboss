const { AsyncLocalStorage } = require('async_hooks');
const context = new AsyncLocalStorage();
function withRun(run, work) { return context.run({ run: run || null }, work); }
function currentRun(store) {
  const scope = context.getStore();
  const run = scope ? scope.run : store.data.runs.filter(r => r.status === 'running').length === 1
    ? store.data.runs.find(r => r.status === 'running') : null;
  if (run && (run.status !== 'running' || run.cancelRequested)) throw new Error('本次执行已结束，不能继续写入执行结果');
  return run;
}
module.exports = { withRun, currentRun };
