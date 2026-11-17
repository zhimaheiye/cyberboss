const { DesktopAgent } = require('./agent');
const { MagpieAgent } = require('./magpie-agent');
const { assessVerification } = require('./verification');
// One interactive lane and one background lane. Jobs retain separate threads.
class AgentPool {
  constructor(options) {
    this.chat = new DesktopAgent({ ...options, lane: 'chat' });
    this.background = new DesktopAgent({ ...options, lane: 'background' });
    this.app = options.app; this.magpie = new MagpieAgent(this.app);
  }
  get active() { return this.chat.active || this.background.active || this.magpie.active; }
  set toolNames(names) { this.chat.toolNames = names; this.background.toolNames = names; }
  hasJob(id) { return [this.chat, this.background, this.magpie].some(a => a.active?.run?.jobId === id); }
  async run(text, options) {
    const run = options.run, job = this.app.jobs.list().find(j => j.id === run?.jobId), config = this.app.magpie.config();
    const policy = job?.executor || 'codex', skill = job ? this.app.skills.describe(job.id) : null;
    const useMagpie = !!job && config.enabled && (policy === 'magpie' || policy === 'auto' && skill?.status === 'ready');
    const reason = !job ? '聊天与自然唤醒由主 Agent 处理' : !config.enabled && policy !== 'codex' ? 'Magpie 未启用，使用 Codex'
      : policy === 'codex' ? '事项指定 Codex' : policy === 'magpie' ? '事项指定 Magpie' : skill?.status === 'ready' ? '自动分配：当前事项有已验证且可复用的技能' : '自动分配：技能尚未就绪或需要复核，使用 Codex';
    run.routing = { policy, selected: useMagpie ? 'magpie' : 'codex', reason, model: useMagpie ? job.magpieModel || config.model : this.app.store.data.settings.model || '', at: new Date().toISOString() };
    this.app.store.save(); this.app.changed();
    if (useMagpie) {
      try {
        const reply = await this.magpie.run(text, { ...options, model: job.magpieModel });
        const action = JSON.parse(reply), verification = assessVerification(run, job, action);
        if (config.fallback && (verification?.status === 'incomplete' || action.learningOutcome === 'uncertain')) throw new Error(verification?.summary || 'Magpie 报告结果仍不确定');
        return reply;
      } catch (error) {
        if (run.cancelRequested || job.status !== 'active' || !config.fallback) throw error;
        run.routing.fallback = { to: 'codex', reason: error.message, at: new Date().toISOString() };
        this.app.store.save(); this.app.changed();
        text += `\n\nMagpie 交接（本轮已执行，不得从头重复操作）：${JSON.stringify({ reason: error.message,
          steps: run.steps || [], attempts: run.checkAttempts || [], progress: this.app.work.state(job.id) })}\n先读取现状核对已发生的动作与不确定结果；沿用当前任务授权，补完缺口。不要重做已经完成的提交／领取／完成标记。`;
      }
    }
    return (options.background ? this.background : this.chat).run(text, options);
  }
  resolveRun(lane) {
    if (['chat', 'background'].includes(lane)) {
      const run = this[lane].active?.run;
      if (!run || run.cancelRequested) throw new Error('工具调用所属执行已结束');
      return run;
    }
    const active = [this.chat.active, this.background.active, this.magpie.active].filter(Boolean);
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
  cancel() { return Promise.all([this.chat.cancel(), this.background.cancel(), this.magpie.cancel()]); }
  view() {
    const foreground = this.chat.view(), background = this.magpie.active ? this.magpie.view() : this.background.view();
    return { ...(foreground.busy ? foreground : background), busy: foreground.busy || background.busy,
      background: !foreground.busy && background.busy, models: this.chat.models.length ? this.chat.models : this.background.models,
      approvals: ['chat', 'background'].flatMap(lane => this[lane].approvals.map(a => ({ ...a, lane,
        jobId: this[lane].active?.run?.jobId, requestId: `${lane}:${a.requestId}` }))),
      workers: ['chat', 'background'].map(lane => {
        const agent = lane === 'background' && this.magpie.active ? this.magpie : this[lane];
        return { lane, busy: !!agent.active, runId: agent.active?.run?.id, jobId: agent.active?.run?.jobId };
      }) };
  }
}
module.exports = { AgentPool };
