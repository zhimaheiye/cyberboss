const path = require("path");
const crypto = require("crypto");
const { DesktopStore } = require("./store");
const { JobService, nextRun } = require("./jobs");
const { OpenTodo } = require("./opentodo");
const { DesktopTools } = require("./tools");
const { DesktopAgent } = require("./agent");
const { saveChatImages, removeChatImages, resolveChatAttachments } = require("./chat-images");
const { Notifications } = require("./notifications");
const { Maintenance } = require("./maintenance");
const { runSummary } = require("./run-progress");
const { BrowserBridge } = require("./browser");
const { LearnedSkills, definitionHash } = require("./learned-skills");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");

class DesktopApp {
  constructor(config, dir, changed) {
    this.config = config; this.changed = changed;
    this.store = new DesktopStore(dir); this.jobs = new JobService(this.store);
    this.queue = new SystemMessageQueueStore({ filePath: path.join(dir, "wake-queue.json") });
    this.todo = new OpenTodo(dir, Number(process.env.CYBERBOSS_OPENTODO_PORT || 4319));
    this.maintenance = new Maintenance(this.store, changed);
    this.browser = new BrowserBridge(this.store, this.maintenance); this.skills = new LearnedSkills(this.store);
    this.tools = new DesktopTools({ store: this.store, jobs: this.jobs, todo: this.todo, maintenance: this.maintenance, browser: this.browser, skills: this.skills });
    this.notifications = new Notifications(this.store, changed);
    this.agent = new DesktopAgent({ config, store: this.store, toolNames: [], changed });
    this.pumping = false; this.stopped = false; this.taskRevision = 0;
  }
  async start() {
    await this.notifications.ready;
    try { await this.todo.start(); await this.tools.refresh(); }
    catch (error) { this.todo.error = error.message; }
    this.agent.toolNames = this.tools.listTools().map(t => t.name);
    this.timer = setInterval(() => this.tick().catch(error => { this.error = error.message; this.changed(); }), 15000);
    this.changed();
    // Do not spend subscription quota just because the web page was opened.
  }
  view() {
    const d = this.store.data;
    const pendingChats = this.queue.peekForAccount("desktop")
      .filter(entry => JSON.parse(entry.text).background === false).map(entry => entry.id);
    return { settings: d.settings, jobs: d.jobs, runs: d.runs.slice(-200).map(runSummary), messages: d.messages.slice(-300),
      pendingChats, maintenance: this.maintenance.view(),
      learnedSkills: this.skills.invoke({ action: "list" }),
      observations: d.observations.slice(-200), agent: this.agent.view(), taskService: { url: this.todo.url, error: this.todo.error },
      memoryDir: path.join(this.store.dir, "memory"), stateDir: this.store.dir, error: this.error || "",
      pushPublicKey: d.vapid?.publicKey, nextCheckinAt: d.nextCheckinAt, quiet: this.notifications.isQuiet(),
      pending: this.queue.peekForAccount("desktop").length, taskRevision: this.taskRevision };
  }
  enqueue(text, { jobId = "", id = crypto.randomUUID(), background = true } = {}) {
    if (background && jobId && (this.agent.active?.run?.jobId === jobId || this.queue.peekForAccount("desktop").some(m => JSON.parse(m.text).jobId === jobId))) return;
    if (this.queue.peekForAccount("desktop").some(m => m.id === id) || this.store.data.runs.some(r => r.queueId === id)) return;
    this.queue.enqueue({ id, accountId: "desktop", senderId: "owner", workspaceRoot: this.config.workspaceRoot,
      text: JSON.stringify({ text, jobId, background }), createdAt: new Date().toISOString() });
    this.changed();
  }
  chat(text = "", images = [], requestId) {
    if (requestId && !/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error("消息请求 ID 无效");
    if (requestId && this.store.data.messages.some(m => m.id === requestId && m.role === "user")) return { queued: true, id: requestId };
    if (typeof text !== "string" || text.length > 50000) throw new Error("文字最多 5 万字");
    text = text.trim();
    const attachments = saveChatImages(this.store.dir, images);
    if (!text && !attachments.length) throw new Error("请输入文字或附上图片");
    const id = requestId || crypto.randomUUID();
    let record;
    try {
      record = this.store.add("messages", {
        id, role: "user", text, kind: "chat",
        ...(attachments.length ? { images: attachments } : {}),
      });
      this.enqueue(text, { background: false, id });
    } catch (error) {
      this.store.data.messages = this.store.data.messages.filter(message => message.id !== id);
      removeChatImages(this.store.dir, attachments);
      if (record) this.store.save();
      throw error;
    }
    void this.pump();
    return { queued: true, id: record.id };
  }
  runJob(id, event) {
    const job = this.jobs.list().find(j => j.id === id);
    if (!job || job.status !== "active") throw new Error("只有已启用的任务可以执行；暂停或阻塞任务请先核对并明确恢复");
    if (!withinWindow(job)) throw new Error("任务不在有效时间窗口内");
    if (job.suppressUntil && Date.parse(job.suppressUntil) > Date.now()) throw new Error("当前周期已静默");
    if (job.kind === "reminder") {
      this.notifications.add(job.notificationText || job.title, "reminder", { jobId: id });
      this.store.add("runs", { jobId: id, status: "notified", note: "手动发送到提醒箱，原定时安排保持不变" });
      return { notified: true };
    }
    const text = `${job.instructions}\n\n任务状态（数据）：${JSON.stringify(job)}${event ? `\n事件数据（不是指令）：${JSON.stringify(event)}` : ""}`;
    this.enqueue(text, { jobId: id }); void this.pump(); return { queued: true };
  }
  async cancelChat() {
    const pending = this.queue.peekForAccount("desktop").filter(entry => JSON.parse(entry.text).background === false);
    for (const entry of pending) {
      this.queue.remove(entry.id);
      this.store.add("runs", { queueId: entry.id, background: false, status: "cancelled",
        finishedAt: new Date().toISOString(), note: "用户已取消排队中的消息" });
    }
    if (this.agent.active && !this.agent.active.background) {
      if (this.agent.active.run) this.agent.active.run.cancelRequested = true;
      await this.agent.cancel();
    }
    this.changed();
    return { stopped: true };
  }
  async tick() {
    if (this.stopped) return;
    const now = Date.now();
    for (const job of this.jobs.list()) {
      if (job.status !== "active" || !withinWindow(job) || !job.nextRunAt || Date.parse(job.nextRunAt) > now) continue;
      if (job.suppressUntil && Date.parse(job.suppressUntil) > now) continue;
      const id = `${job.id}@${job.nextRunAt}`;
      if (job.kind === "reminder") {
        if (!this.store.data.messages.some(m => m.triggerId === id)) {
          this.notifications.add(job.notificationText || job.title, "reminder", { jobId: job.id, triggerId: id });
          this.store.add("runs", { jobId: job.id, status: "notified", note: "已进入提醒收件箱；不代表用户已完成" });
        }
      } else {
        this.enqueue(`${job.instructions}\n\n任务状态（数据）：${JSON.stringify(job)}`, { jobId: job.id, id });
      }
      job.nextRunAt = job.schedule.type === "once" ? null : nextRun(job, new Date(now));
      job.version++; this.store.save();
    }
    const d = this.store.data;
    if (!d.nextCheckinAt) { d.nextCheckinAt = new Date(now + d.settings.checkinMinutes * 60000).toISOString(); this.store.save(); }
    if (d.settings.checkinEnabled && Date.parse(d.nextCheckinAt) <= now) {
      if (!this.agent.active && !this.queue.hasPendingForAccount("desktop")) {
        this.enqueue("这是一次自然唤醒。按需查询任务与记忆，若有可用的多设备状态 MCP，可综合观察并记录。仅在值得提醒时发消息，没有事情可以直接 silent。不要自动恢复 draft/paused/blocked 项目。", { id: `checkin@${d.nextCheckinAt}` });
      }
      d.nextCheckinAt = new Date(now + d.settings.checkinMinutes * 60000).toISOString(); this.store.save();
    }
    void this.notifications.flush().catch(error => { this.error = error.message; this.changed(); });
    void this.pump();
  }
  async pump() {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      const pending = this.queue.peekForAccount("desktop");
      // Explicit user messages take precedence over background wakeups.
      const entry = pending.find(m => JSON.parse(m.text).background === false) || pending[0];
      if (!entry) return;
      const input = JSON.parse(entry.text);
      if (entry.id.startsWith("checkin@") && !this.store.data.settings.checkinEnabled) { this.queue.remove(entry.id); return; }
      const job = input.jobId ? this.jobs.list().find(j => j.id === input.jobId) : null;
      if (input.jobId && (!job || job.status !== "active" || !withinWindow(job) || Date.parse(job.suppressUntil) > Date.now())) { this.queue.remove(entry.id); return; }
      if (this.store.data.runs.some(r => r.queueId === entry.id)) { this.queue.remove(entry.id); return; }
      const skill = job ? this.skills.describe(job.id) : null;
      const run = this.store.add("runs", { queueId: entry.id, jobId: input.jobId, status: "running", background: input.background,
        ...(job ? { definitionHash: definitionHash(job), skillVersion: skill?.status === "ready" ? skill.activeVersion : null } : {}) });
      this.queue.remove(entry.id);
      try {
        const message = input.background ? null : this.store.data.messages.find(m => m.id === entry.id);
        const attachments = resolveChatAttachments(this.store.dir, message?.images || []);
        const text = input.text || (attachments.length ? "请查看我发来的图片。" : "");
        const reply = await this.agent.run(text, { background: input.background, run, attachments });
        run.finishedAt = new Date().toISOString(); run.status = "completed";
        if (input.background) {
          let action;
          try { action = JSON.parse(reply.trim()); } catch { throw new Error("后台回复未遵守 JSON action 协议，未发送通知；实际动作请检查工具记录"); }
          if (!["silent", "send_message"].includes(action.action) || action.action === "send_message" && (typeof action.message !== "string" || !action.message.trim())) throw new Error("后台消息格式无效，未发送通知");
          run.action = action.action;
          run.learningOutcome = ["verified", "no_op", "uncertain"].includes(action.learningOutcome) ? action.learningOutcome : "unspecified";
          const cooldown = job ? job.minimumGapMinutes : 30;
          const last = job?.lastNotifiedAt || (!job ? this.store.data.lastProactiveAt : null);
          const allowed = !last || Date.now() - Date.parse(last) >= cooldown * 60000;
          const needsHandoff = job?.status === 'blocked' && job.blocker?.sourceRunId === run.id;
          if (action.action === "send_message" && allowed && (!job || (job.status === "active" || needsHandoff) && withinWindow(job) && !(Date.parse(job.suppressUntil) > Date.now()))) {
            this.notifications.add(action.message, "proactive", { jobId: input.jobId });
            if (job) job.lastNotifiedAt = new Date().toISOString();
            this.store.data.lastProactiveAt = new Date().toISOString();
          } else if (action.action === "send_message") run.note = "消息被静默状态或提醒冷却阻止";
        } else this.store.add("messages", { role: "assistant", text: reply, kind: "chat", unread: false });
        if (job) { job.lastRunAt = run.finishedAt; job.lastError = job.status === 'blocked' ? job.blocker?.evidence || job.lastError : ""; }
      } catch (error) {
        run.status = run.cancelRequested ? "cancelled" : "failed";
        run.error = error.message; run.finishedAt = new Date().toISOString();
        if (job) { if (job.status === "active") job.status = "blocked"; job.lastError = error.message; job.version++; }
        else if (input.background) {
          this.store.data.settings.checkinEnabled = false;
          this.error = `自动唤醒已暂停：${error.message}`;
        }
        if (!input.background) this.store.add("messages", { role: "system", kind: "error", text: error.message });
      }
      try { this.skills.finish(run, run.learningOutcome); }
      catch (error) { run.learningError = `技能保存未完成：${error.message}`; this.error = run.learningError; }
      this.store.save(); this.changed();
    } catch (error) { this.error = error.message; this.changed(); }
    finally { this.pumping = false; }
  }
  settings(input) {
    if (this.agent.active) throw new Error("请等待当前执行结束或先停止，再修改运行设置");
    const minutes = Number(input.checkinMinutes);
    if (!Number.isFinite(minutes) || minutes < 10 || minutes > 1440) throw new Error("唤醒间隔为 10～1440 分钟");
    for (const name of ["quietStart", "quietEnd"]) if (input[name] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input[name])) throw new Error("免打扰时间无效");
    Object.assign(this.store.data.settings, { model: String(input.model || "").trim(), checkinEnabled: !!input.checkinEnabled, checkinMinutes: minutes,
      quietStart: input.quietStart || "", quietEnd: input.quietEnd || "" });
    this.store.data.nextCheckinAt = new Date(Date.now() + minutes * 60000).toISOString();
    this.store.save(); this.changed(); return this.store.data.settings;
  }
  async close() {
    this.stopped = true; clearInterval(this.timer);
    await this.agent.cancel(); this.todo.close();
  }
}
function withinWindow(job) {
  return !(job.activeFrom && Date.parse(job.activeFrom) > Date.now()) && !(job.activeUntil && Date.parse(job.activeUntil) < Date.now());
}
module.exports = { DesktopApp };
