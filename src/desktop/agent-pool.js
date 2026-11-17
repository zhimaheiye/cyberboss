const { DesktopAgent } = require('./agent');
// One interactive lane and one background lane. Jobs retain separate threads.
class AgentPool {
  constructor(options) {
    this.chat = new DesktopAgent({ ...options, lane: 'chat' });
    this.background = new DesktopAgent({ ...options, lane: 'background' });
  }
  get active() { return this.chat.active || this.background.active; }
  set toolNames(names) { this.chat.toolNames = names; this.background.toolNames = names; }
  hasJob(id) { return [this.chat, this.background].some(a => a.active?.run?.jobId === id); }
  run(text, options) { return (options.background ? this.background : this.chat).run(text, options); }
  resolveRun(lane) {
    if (['chat', 'background'].includes(lane)) {
      const run = this[lane].active?.run;
      if (!run || run.cancelRequested) throw new Error('工具调用所属执行已结束');
      return run;
    }
    const active = [this.chat.active, this.background.active].filter(Boolean);
    if (active.length > 1) throw new Error('并发执行时须通过工作台 MCP 调用工具，或提供 X-Cyberboss-Lane 请求头');
    return active[0]?.run || null;
  }
  async approve(id, accept, answers) {
    const [lane, ...rest] = String(id).split(':');
    if (!['chat', 'background'].includes(lane)) throw new Error('审批请求已失效，请刷新');
    return this[lane].approve(rest.join(':'), accept, answers);
  }
  async login() { if (this.active) throw new Error('请等当前执行结束后登录'); return this.chat.login(); }
  refreshModels() { return this.chat.refreshModels(); }
  cancel() { return Promise.all([this.chat.cancel(), this.background.cancel()]); }
  view() {
    const foreground = this.chat.view(), background = this.background.view();
    return { ...(foreground.busy ? foreground : background), busy: foreground.busy || background.busy,
      background: !foreground.busy && background.busy, models: this.chat.models.length ? this.chat.models : this.background.models,
      approvals: ['chat', 'background'].flatMap(lane => this[lane].approvals.map(a => ({ ...a, lane,
        jobId: this[lane].active?.run?.jobId, requestId: `${lane}:${a.requestId}` }))),
      workers: ['chat', 'background'].map(lane => ({ lane, busy: !!this[lane].active, runId: this[lane].active?.run?.id,
        jobId: this[lane].active?.run?.jobId })) };
  }
}
module.exports = { AgentPool };
