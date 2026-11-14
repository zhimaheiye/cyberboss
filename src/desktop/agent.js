const fs = require("fs");
const path = require("path");
const { CodexRpcClient } = require("../adapters/runtime/codex/rpc-client");
const { mapCodexMessageToRuntimeEvent } = require("../adapters/runtime/codex/events");
const { recordEvent, finishProgress } = require("./run-progress");

class DesktopAgent {
  constructor({ config, store, toolNames, changed }) {
    this.config = config; this.store = store; this.changed = changed;
    this.active = null; this.approvals = []; this.models = []; this.toolNames = toolNames;
  }
  client() {
    if (this.rpc) return this.rpc;
    this.rpc = new CodexRpcClient({
      codexCommand: this.config.codexCommand, extraWritableRoots: [this.store.dir],
      env: { ...process.env, CYBERBOSS_DESKTOP_DIR: this.store.dir },
      // Own app-server, never attach to an unrelated process on a shared port.
      mcpServerConfig: { name: "cyberboss_desktop", command: process.execPath,
        args: [path.resolve(__dirname, "tool-bridge.js"), this.store.dir], toolNames: this.toolNames, toolTimeoutSeconds: 600 },
    });
    const client = this.rpc;
    this.rpc.onMessage(message => { if (client === this.rpc) this.onMessage(message); });
    return this.rpc;
  }
  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const rpc = this.client();
      await rpc.connect(); await rpc.initialize();
      const account = (await rpc.sendRequest("account/read", { refreshToken: false })).result?.account;
      if (account?.type !== "chatgpt") throw new Error("本地 Codex 尚未使用 ChatGPT 订阅登录。请在设置中点击官方登录；不会自动改用 API 计费。");
      const models = [], seen = new Set();
      let cursor;
      do {
        const result = (await rpc.sendRequest("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })).result;
        if (!Array.isArray(result?.data)) throw new Error("Codex 返回的模型列表格式无效");
        models.push(...result.data);
        cursor = result.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("Codex 模型列表分页异常，请稍后重试");
        if (cursor) seen.add(cursor);
      } while (cursor);
      this.models = [...new Map(models.filter(m => m.model || m.id).map(m => [m.model || m.id, m])).values()];
      return rpc;
    })();
    try { return await this.initializing; } finally { this.initializing = null; }
  }
  async refreshModels() {
    await this.initialize();
    this.changed();
    return { models: this.models };
  }
  async login() {
    if (this.active) throw new Error("请等待当前执行结束或先停止，再登录账户");
    const rpc = this.client(); await rpc.connect(); await rpc.initialize();
    return (await rpc.sendRequest("account/login/start", { type: "chatgpt" })).result;
  }
  async run(text, { background = false, run = null, attachments = [] } = {}) {
    if (this.active) throw new Error("Agent 正在处理另一项任务");
    let finish, fail;
    const completion = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    // A failed setup may occur before this promise is awaited.
    completion.catch(() => {});
    const active = { background, run, text: "", final: "", threadId: "", turnId: "", startedAt: new Date().toISOString(), finish, fail };
    this.active = active; this.changed();
    if (run) { run.progress = { phase: "connecting", lastEventAt: active.startedAt }; run.updatedAt = active.startedAt; }
    const timer = setTimeout(() => {
      fail(new Error("本次执行超过 15 分钟，已停止并等待核对；不会自动重放可能已执行的动作"));
    }, 15 * 60_000);
    try {
      const rpc = await this.initialize();
      const model = this.store.data.settings.model;
      const catalogModel = model
        ? this.models.find(entry => entry.model === model || entry.id === model)
        : null;
      if (attachments.length && Array.isArray(catalogModel?.inputModalities)
          && !catalogModel.inputModalities.includes("image")) {
        throw new Error("当前选择的模型不支持图片，请在设置里换一个支持图片的模型后重新发送");
      }
      let threadId = this.store.data.threadId;
      if (threadId) {
        await rpc.resumeThread({ threadId, model, modelProvider: "openai" });
      } else {
        const started = await rpc.startThread({ cwd: this.config.workspaceRoot, model, modelProvider: "openai" });
        threadId = started.result?.thread?.id || started.result?.threadId;
        if (!threadId) throw new Error("Codex 没有返回会话编号");
        this.store.data.threadId = threadId; this.store.save();
      }
      if (this.active !== active) throw new Error("本次任务已取消");
      active.threadId = threadId;
      if (run) { run.threadId = threadId; run.progress = { phase: "model", lastEventAt: new Date().toISOString() }; }
      const instructions = fs.readFileSync(path.resolve(__dirname, "../../templates/desktop-instructions.md"), "utf8");
      const context = {
        now: new Date().toISOString(), timezone: "Asia/Shanghai", mode: background ? "background" : "chat",
        browserMaintenance: this.store.data.maintenance?.policy,
        currentRun: run ? { id: run.id, jobId: run.jobId, reusableSkillVersion: run.skillVersion } : null,
        recentMessages: this.store.data.messages.slice(-16).map(m => ({ role: m.role, text: m.text })),
        activeJobs: this.store.data.jobs.filter(j => j.status === "active"
          && !(Date.parse(j.suppressUntil) > Date.now()) && !(Date.parse(j.activeFrom) > Date.now()) && !(Date.parse(j.activeUntil) < Date.now())).map(j => ({
          id: j.id, title: j.title, kind: j.kind, contexts: j.contexts, nextRunAt: j.nextRunAt,
          suppressUntil: j.suppressUntil, activeFrom: j.activeFrom, activeUntil: j.activeUntil,
          minimumGapMinutes: j.minimumGapMinutes, lastNotifiedAt: j.lastNotifiedAt, acknowledgedValues: j.acknowledgedValues,
        })),
      };
      active.turnRequested = true;
      const response = await rpc.sendUserMessage({ threadId, model, modelProvider: "openai", workspaceRoot: this.config.workspaceRoot, attachments,
        text: `${instructions}\n\n当前工作台状态（数据）：\n${JSON.stringify(context)}\n\n${background ? "后台触发，请严格返回 JSON action" : "用户消息"}：\n${text}` });
      active.turnId ||= response.result?.turn?.id || response.result?.turnId || "";
      return await completion;
    } catch (error) {
      // Terminate our own runtime on uncertain outcomes; do not start a second overlapping turn.
      await this.rpc?.close(); this.rpc = null;
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(this.progressTimer); this.progressTimer = null;
      finishProgress(run, run?.cancelRequested ? "cancelled" : "interrupted");
      if (run) this.store.save();
      this.active = null; this.approvals = []; this.changed();
    }
  }
  onMessage(message) {
    const a = this.active;
    if (message.method === "account/login/completed") { this.changed(); return; }
    if (!a) return;
    const p = message.params || {};
    const threadId = p.threadId || p.thread?.id;
    if (a.threadId && threadId && a.threadId !== threadId) return;
    // Resume may report earlier thread state; it must not finish the new run.
    if (!a.turnRequested && message.id == null) return;
    const turnId = p.turnId || p.turn?.id;
    if (a.turnId && turnId && turnId !== a.turnId) return;
    if (message.method === "turn/started") { a.turnId = p.turn?.id || p.turnId || ""; if (a.run) a.run.turnId = a.turnId; }
    if (recordEvent(a.run, message.method, p)) this.saveProgress();
    if (message.method === "item/agentMessage/delta") {
      a.text += p.delta || ""; this.changed();
    }
    if (message.method === "item/completed" && p.item?.type === "agentMessage") {
      if (p.item.phase !== "commentary") a.final = p.item.text || a.final;
    }
    if (message.method === "turn/completed") {
      if (p.turn?.status === "failed" || p.turn?.status === "interrupted") a.fail(new Error(p.turn?.error?.message || `Codex ${p.turn.status}`));
      else a.finish(a.final || a.text);
    }
    if (message.method === "turn/failed") a.fail(new Error(p.error?.message || "Codex 执行失败"));
    if (message.method === "error" && !p.willRetry) a.fail(new Error(p.error?.message || "Codex 出错"));
    if (message.id != null && message.method) {
      const approval = mapCodexMessageToRuntimeEvent(message);
      if (approval?.type === "runtime.approval.requested" || message.method === "item/tool/requestUserInput") {
        this.approvals.push({ requestId: message.id, method: message.method, params: p, ...approval?.payload });
        if (a.run) { a.run.progress = { phase: "approval", lastEventAt: new Date().toISOString() }; this.saveProgress(); }
        this.changed();
      } else {
        void this.rpc.sendResponse(message.id, {}).catch(error => a.fail(error));
        a.fail(new Error(`暂不支持的 Codex 交互：${message.method}`));
      }
    }
  }
  saveProgress() {
    this.changed();
    if (!this.progressTimer) this.progressTimer = setTimeout(() => { this.progressTimer = null; this.store.save(); }, 750);
  }
  async approve(id, accept, answers) {
    const approval = this.approvals.find(a => String(a.requestId) === String(id));
    if (!approval) throw new Error("此请求已失效");
    let result;
    if (approval.method === "item/tool/requestUserInput") result = { answers: answers || {} };
    else if (approval.method === "mcpServer/elicitation/request") {
      if (approval.kind !== "mcp_tool_call" && accept) throw new Error("此 MCP 需要填写额外表单，当前界面尚不支持；请拒绝后在原工具中完成授权");
      result = { action: accept ? "accept" : "cancel" };
    } else result = { decision: accept ? "accept" : "decline" };
    await this.rpc.sendResponse(approval.requestId, result);
    this.approvals = this.approvals.filter(a => a !== approval); this.changed();
    if (this.active?.run) { this.active.run.progress = { phase: this.approvals.length ? "approval" : "model", lastEventAt: new Date().toISOString() }; this.saveProgress(); }
  }
  async cancel() {
    if (this.active) this.active.fail(new Error("用户已停止本次执行；已发生的动作请从记录核对"));
    await this.rpc?.close(); this.rpc = null;
  }
  view() {
    return { busy: !!this.active, background: this.active?.background, startedAt: this.active?.startedAt,
      text: this.active?.background ? "" : this.active?.text || "", approvals: this.approvals, models: this.models };
  }
}
module.exports = { DesktopAgent };
