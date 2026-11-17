const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { withRun } = require('./run-context');
const { recordEvent, finishProgress, preview } = require('./run-progress');
// Use the existing workbench tools; Codex-only MCP plugins stay with Codex.
const TOOLS = new Set(['cb_recall','cb_work','cb_verification','cb_browser','cb_maintenance','cb_skills','cb_memory','cb_observe','cb_task_history','cb_toolbox']);
class MagpieAgent {
  constructor(app) { this.app = app; this.active = null; this.approvals = []; }
  view() { return { busy: !!this.active, background: true, startedAt: this.active?.startedAt, text: '', approvals: [], models: [] }; }
  cancel() { if (this.active) { this.active.run.cancelRequested = true; this.active.controller.abort(); } }
  async run(text, { run, model }) {
    if (this.active) throw new Error('Magpie 正在执行另一项工作');
    const app = this.app, c = { ...app.magpie.config(), ...(model ? { model } : {}) }, controller = new AbortController();
    this.active = { run, background: true, startedAt: new Date().toISOString(), controller };
    const timer = setTimeout(() => controller.abort(), 8 * 60000);
    try {
      const catalog = app.tools.listTools().filter(t => TOOLS.has(t.name) || t.name.startsWith('opentodo_'));
      const instructions = fs.readFileSync(path.resolve(__dirname, '../../templates/desktop-instructions.md'), 'utf8');
      const skill = app.skills.read(run.jobId);
      const kimiPath = path.join(os.homedir(), '.codex', 'skills', 'kimi-webbridge', 'SKILL.md');
      const browserGuide = fs.existsSync(kimiPath) ? fs.readFileSync(kimiPath, 'utf8') : '';
      const seenCalls = new Set();
      const messages = [{ role: 'system', content: `${instructions}\n\n本轮通过 Magpie API 执行，使用传入的 function tools。仅操作当前 job，不能改变执行者、模型配置或自动恢复任务。需要目录外工具、任意本地文件或系统操作时，返回 {"action":"handoff","reason":"具体缺口"} 交回 Codex。cb_work 仅开放 read/report；工具箱仅开放 list/get/related。当前浏览器技能参考：\n${browserGuide}\n工作台工具的传输与排队要求仍适用。` },
        { role: 'user', content: `${text}\n\n上下文数据：${JSON.stringify({ now: new Date().toISOString(), currentRun: { id: run.id, jobId: run.jobId },
          progress: app.work.state(run.jobId), inputEvents: run.inputEvents || [], reusableSkill: skill,
          personalPreferences: app.store.data.promptPreferences?.versions?.at(-1)?.text || '' })}` }];
      for (let round = 0; round < c.maxRounds; round++) {
        if (run.cancelRequested || controller.signal.aborted) throw new Error('Magpie 执行已停止或达到时限');
        const job = app.jobs.list().find(j => j.id === run.jobId);
        if (job?.status !== 'active') throw new Error('任务状态已变化，Magpie 停止继续执行');
        run.progress = { phase: 'model', lastEventAt: new Date().toISOString() }; run.updatedAt = run.progress.lastEventAt;
        run.routing.requests = round + 1; app.store.save(); app.changed();
        const result = await app.magpie.complete(messages, catalog, c, controller.signal);
        if (run.cancelRequested || controller.signal.aborted) throw new Error('Magpie 执行已停止或达到时限');
        for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
          const n = result.usage[key]; if (Number.isFinite(n)) { run.routing.usage ||= {}; run.routing.usage[key] = (run.routing.usage[key] || 0) + n; }
        }
        const message = result.message, calls = message.tool_calls || [];
        if (!Array.isArray(calls) || calls.length > 30) throw new Error('Magpie 返回的工具调用数量或格式无效');
        if (!calls.length) {
          if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('Magpie 未返回结论');
          const reply = message.content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
          let action; try { action = JSON.parse(reply); } catch { throw new Error('Magpie 最终回复不是任务结果 JSON'); }
          if (action.action === 'handoff') throw new Error(`Magpie 请求交接：${String(action.reason || '需要 Codex 的工具或判断').slice(0, 2000)}`);
          if (!['silent','send_message','retry'].includes(action.action) || action.action === 'send_message' && !action.message?.trim()) throw new Error('Magpie 返回了无效的任务结论');
          recordEvent(run, 'item/completed', { item: { id: crypto.randomUUID(), type: 'agentMessage', text: reply, phase: 'final' } });
          return reply;
        }
        // Some providers require their transient reasoning field alongside tool calls.
        // Keep it only in this request loop; do not persist or display it.
        messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls,
          ...(typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : {}) });
        for (const call of calls) {
          if (run.cancelRequested || controller.signal.aborted) throw new Error('Magpie 执行已停止');
          if (app.jobs.list().find(j => j.id === run.jobId)?.status !== 'active') throw new Error('任务已暂停或结束，剩余工具调用未执行');
          if (!call.id || seenCalls.has(call.id)) throw new Error('Magpie 工具调用 ID 缺失或重复，该调用未执行');
          seenCalls.add(call.id);
          const item = { id: crypto.randomUUID(), type: 'mcpToolCall', server: 'Magpie → 工作台', tool: call.function?.name, arguments: {} };
          let output;
          try {
            if (!call.id || call.type !== 'function' || !catalog.some(t => t.name === item.tool)) throw new Error('此工具不在 Magpie 执行能力内，请交回 Codex');
            item.arguments = JSON.parse(call.function.arguments || '{}');
            if (!item.arguments || typeof item.arguments !== 'object' || Array.isArray(item.arguments)) throw new Error('工具参数必须是对象');
            if (item.tool === 'cb_work' && !['read','report'].includes(item.arguments.action)
              || item.tool === 'cb_toolbox' && !['list','get','related'].includes(item.arguments.action)
              || item.tool === 'cb_browser' && !browserGuide) throw new Error('此步骤需要主 Agent 处理，请交回 Codex');
            recordEvent(run, 'item/started', { item }); app.store.save(); app.changed();
            output = await withRun(run, () => app.tools.invokeTool(item.tool, item.arguments, 'agent'));
            recordEvent(run, 'item/completed', { item: { ...item, result: output, status: 'completed' } });
          } catch (error) {
            output = { isError: true, error: error.message };
            recordEvent(run, 'item/completed', { item: { ...item, result: output, error: error.message, status: 'failed' } });
          }
          if (item.tool?.startsWith('opentodo_') && !/^opentodo_(list|get|search|today)_/.test(item.tool)) { app.taskRevision++; app.retrieval.sources.invalidateTasks(); }
          app.store.save(); app.changed();
          messages.push({ role: 'tool', tool_call_id: call.id, content: preview(output, 24000) });
        }
      }
      throw new Error(`Magpie 已达到 ${c.maxRounds} 次模型请求上限，任务尚未结束`);
    } finally { clearTimeout(timer); finishProgress(run); this.active = null; app.store.save(); app.changed(); }
  }
}
module.exports = { MagpieAgent };
