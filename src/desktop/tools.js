const object = properties => ({ type: "object", properties, additionalProperties: false });
const string = { type: "string" };
const TOOLS = [
  { name: "cb_browser", description: "Use installed kimi-webbridge skill with this UTF-8 file-body transport. Read its SKILL.md first; pass action/args and a stable task session. Fresh connection status and authorized recovery run BEFORE dispatch; a dispatched action is never replayed automatically. BROWSER_NOT_READY means this action was NOT sent and requires agent diagnosis, not an automatic human handoff. Creates/sends/removes a unique request file; do not use apply_patch and curl for each action. Use observed refs and verify effects. No additional website authorization.", inputSchema: object({ action: { enum: require('./browser').ACTIONS }, args: { type: 'object' }, session: string }) },
  { name: "cb_skills", description: "Learn reusable skills for recurring jobs. read/list first; save a draft with expectedVersion (0 for new), jobId, sourceRunId, concrete steps, verification, failureHandling, evidence. Source must be an actual run of this job. A draft becomes reusable only after that run completes successfully with learningOutcome=verified, unchanged task definition, and active job. Existing successful run IDs may be used only if they carry verified outcome. read returns version history and SKILL.md. Skills are experience, never new authorization. Do not invent successful observations or store credentials/transient DOM refs.", inputSchema: object({ action: { enum: ['list','read','save'] }, jobId:string, sourceRunId:string, expectedVersion:{type:'integer'}, version:{type:'integer'}, steps:string, verification:string, failureHandling:string, evidence:string }) },
  { name: "cb_maintenance", description: "Owner-authorized Kimi maintenance. policy reads authorization (its status is historical). status reads LIVE connection without mutation. check processes authorized updates. prepare_browser preserves healthy connections; otherwise starts the daemon, waits for browser reconnect, and makes at most one recovery restart. diagnose reads fresh status and connection logs. ready=false means continue agent diagnosis, NOT humanRequired. Inspect browser/profile/extension/connection settings using available local tools before handoff. No repeated confirmation while policy.enabled. Never restart during an active browser action.", inputSchema: object({ action: { enum: ["policy", "status", "check", "prepare_browser", "diagnose"] } }) },
  { name: "cb_jobs", description: "Manage background work and reminders. list/get before save. Reminder fires directly; watch/operation invokes Agent; opportunity only on manual/event trigger. Preserve recurrence, acknowledged values and paused/blocked state. Imported definitions are drafts. status active means authorizing execution on this machine.", inputSchema: object({
    action: { enum: ["list", "get", "save", "acknowledge"] }, id: string, value: string, until: string, note: string,
    job: { type: "object", description: "save fields: id and current version for existing job; title, kind (reminder/watch/operation/opportunity), status (draft/active/paused/blocked/done), instructions, notificationText, contexts, timezone, schedule ({type:manual|once|recurring,at?,rrule?,time?,startDate?}), minimumGapMinutes, suppressUntil, activeFrom, activeUntil, taskId. Agent setting blocked MUST provide blocker {kind:human_required|uncertain_effect|user_requested,component:browser_connection for connection problems,evidence:current tool/page evidence,attempts:recovery attempted and outcomes,nextAction:minimal human action or reconciliation}. Transient pre-action infrastructure failure is not a reason to block a recurring job; keep schedule active. Hourly: recurring rrule FREQ=HOURLY;BYMINUTE=0;BYSECOND=0 and time 00:00, or FREQ=HOURLY;INTERVAL=N. Use suitable minimumGapMinutes. OpenTodo does not accept hourly recurrence. Check sourceDefinition for import constraints." },
  }) },
  { name: "cb_memory", description: "Local Markdown memory, keyword search for now. read before write and supply expectedText to preserve concurrent human edits. Preserve user/observed/inferred evidence and source dates.", inputSchema: object({ action: { enum: ["list", "search", "read", "write"] }, name: string, query: string, text: string, expectedText: string }) },
  { name: "cb_observe", description: "Read or append life timeline observations. A window switch is not proof of distraction. Explicitly label source and evidence type.", inputSchema: object({ action: { enum: ["list", "append"] }, text: string, source: string, evidence: { enum: ["user", "observed", "inferred"] }, observedAt: string }) },
];
const ALLOWED_TASK_TOOLS = new Set(["list_tasks", "get_task", "search_tasks", "today_summary", "list_projects", "create_project", "update_project", "create_tasks", "update_tasks", "complete_tasks", "reopen_tasks", "schedule_tasks", "move_tasks", "list_notes", "get_note", "search_notes", "create_note", "append_to_note", "add_reminders", "update_reminders", "remove_reminders", "list_workspaces", "list_labels", "add_comment"]);

class DesktopTools {
  constructor({ store, jobs, todo, maintenance, browser, skills }) { Object.assign(this, { store, jobs, todo, maintenance, browser, skills }); this.taskTools = []; }
  async refresh() {
    this.taskTools = (await this.todo.tools()).filter(t => ALLOWED_TASK_TOOLS.has(t.name)).map(t => ({
      ...t, name: `opentodo_${t.name}`,
      description: t.description + (['create_tasks', 'update_tasks'].includes(t.name)
        ? ' For hourly recurrence, save a cb_jobs recurring schedule instead. If a task card is needed, create it without recurrence and link its id as taskId.' : ''),
    }));
  }
  listTools() { return [...TOOLS, ...this.taskTools]; }
  async invokeTool(name, args = {}) {
    if (name === "cb_browser") return this.browser.command(args);
    if (name === "cb_skills") return this.skills.invoke(args);
    if (name === "cb_maintenance") return this.maintenance.invoke(args.action);
    if (name.startsWith("opentodo_") && this.taskTools.some(t => t.name === name)) return this.todo.call(name.slice(9), args);
    if (name === "cb_jobs") {
      if (args.action === "list") return this.jobs.list();
      if (args.action === "get") return this.jobs.list().find(j => j.id === args.id) || null;
      if (args.action === "save") {
        const input = args.job || {};
        if (input.status === 'blocked') {
          const block = input.blocker;
          if (!block || !['human_required', 'uncertain_effect', 'user_requested'].includes(block.kind)
            || typeof block.evidence !== 'string' || !block.evidence.trim()
            || typeof block.attempts !== 'string' || !block.attempts.trim()
            || typeof block.nextAction !== 'string' || !block.nextAction.trim()) {
            throw new Error('Agent 阻塞任务前必须提供 blocker={kind:human_required|uncertain_effect|user_requested,evidence:具体工具或页面证据,attempts:已经尝试的恢复步骤,nextAction:用户必须完成的动作或结果核对方式}。暂时离线且无业务副作用时保持 active，继续诊断或留待下一周期；不要把连接失败当成人工门槛。');
          }
          if (block.component === 'browser_connection' && block.kind === 'human_required') {
            const live = await this.maintenance.invoke('status');
            if (live.ready) throw new Error('浏览器已经连接，请继续任务；旧的断连记录不能作为阻塞依据');
            const latest = this.maintenance.data.records.at(-1);
            if (!latest || !['prepare_browser', 'diagnose'].includes(latest.action)
              || !latest.finishedAt || Date.now() - Date.parse(latest.finishedAt) > 120000) {
              throw new Error('请先调用 prepare_browser / diagnose 并完成浏览器侧排查，再提供人工门槛的具体证据');
            }
          }
          const run = [...this.store.data.runs].reverse().find(r => r.status === 'running');
          input.blocker = { kind: block.kind, component: String(block.component || '').slice(0, 100),
            evidence: block.evidence.slice(0, 6000), attempts: block.attempts.slice(0, 6000),
            nextAction: block.nextAction.slice(0, 2000), sourceRunId: run?.id || null,
            observedAt: new Date().toISOString() };
        }
        return this.jobs.save(input);
      }
      if (args.action === "acknowledge") return this.jobs.acknowledge(args);
    }
    if (name === "cb_memory") return this.store.memory(args);
    if (name === "cb_observe") {
      if (args.action === "list") return this.store.data.observations.slice(-100);
      if (args.action === "append") {
        if (!["user", "observed", "inferred"].includes(args.evidence) || !args.text || !args.source) throw new Error("请提供文本、来源和证据类型");
        if (args.observedAt && !Number.isFinite(Date.parse(args.observedAt))) throw new Error("观测时间无效");
        return this.store.add("observations", { text: String(args.text).slice(0, 20000), source: String(args.source).slice(0, 2000), evidence: args.evidence, observedAt: args.observedAt || new Date().toISOString() });
      }
    }
    throw new Error("未知工作台工具或操作");
  }
}
module.exports = { DesktopTools };
