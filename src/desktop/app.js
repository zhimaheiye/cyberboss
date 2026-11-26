const path = require("path");
const crypto = require("crypto");
const { DesktopStore, finishUserStoppedRun } = require("./store");
const { JobService, nextRun } = require("./jobs");
const { OpenTodo } = require("./opentodo");
const { TaskHistory } = require("./task-history");
const { observationViews } = require('./observations');
const { DesktopTools } = require("./tools");
const { AgentPool } = require("./agent-pool");
const { Magpie } = require('./magpie');
const { Moraine } = require('./moraine');
const { WorkState } = require('./work-state');
const { PromptPreferences } = require('./prompt-preferences');
const { saveChatImages, removeChatImages, resolveChatAttachments } = require("./chat-images");
const { Notifications } = require("./notifications");
const { Breathing } = require("./breathing");
const { AnswerBook } = require("./answer-book");
const { DecisionGuide } = require('./decision-guide');
const { Procrastination } = require('./procrastination');
const { Toolbox } = require('./toolbox');
const { Retrieval } = require('./retrieval');
const { Retention } = require('./retention');
const { ThreadMaintenance } = require('./thread-maintenance');
const { Maintenance } = require("./maintenance");
const { runSummary } = require("./run-progress");
const { readRunHistory } = require('./run-history');
const { assessVerification, deferVerification } = require('./verification');
const { BrowserBridge } = require("./browser");
const { LearnedSkills, definitionHash } = require("./learned-skills");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");

class DesktopApp {
  constructor(config, dir, changed) {
    this.config = config; this.changed = changed;
    this.store = new DesktopStore(dir); this.jobs = new JobService(this.store);
    this.queue = new SystemMessageQueueStore({ filePath: path.join(dir, "wake-queue.json") });
    this.todo = new OpenTodo(dir, Number(process.env.CYBERBOSS_OPENTODO_PORT || 4319));
    this.taskHistory = new TaskHistory(this.store, this.todo);
    this.maintenance = new Maintenance(this.store, changed);
    this.browser = new BrowserBridge(this.store, this.maintenance, changed); this.skills = new LearnedSkills(this.store);
    this.breathing = new Breathing(this.store, changed);
    this.answerBook = new AnswerBook(dir);
    this.decisionGuide = new DecisionGuide(dir);
    this.procrastination = new Procrastination(this);
    this.toolbox = new Toolbox(this.store);
    this.retrieval = new Retrieval(this, changed);
    this.work = new WorkState(this);
    this.preferences = new PromptPreferences(this.store);
    this.retention = new Retention(this);
    this.threadMaintenance = new ThreadMaintenance(this);
    this.magpie = new Magpie(this.store, changed);
    this.moraine = new Moraine(changed);
    this.toolbox.resolve = ref => this.retrieval.sources.read(ref);
    this.tools = new DesktopTools({ store: this.store, jobs: this.jobs, todo: this.todo, taskHistory: this.taskHistory, maintenance: this.maintenance,
      browser: this.browser, skills: this.skills, toolbox: this.toolbox, retrieval: this.retrieval, retention: this.retention, work: this.work, magpie: this.magpie });
    this.notifications = new Notifications(this.store, changed, this.breathing);
    this.agent = new AgentPool({ config, store: this.store, toolNames: [], changed, app: this });
    this.lanes = new Set(); this.stopped = false; this.taskRevision = 0;
  }
  async start() {
    this.moraine.start();
    await this.notifications.ready;
    try { await this.todo.start(); await this.tools.refresh(); }
    catch (error) { this.todo.error = error.message; }
    this.agent.toolNames = this.tools.listTools().map(t => t.name);
    this.noticeJobExceptions();
    this.timer = setInterval(() => this.tick().catch(error => { this.error = error.message; this.changed(); }), 15000);
    this.changed();
    // Do not spend subscription quota just because the web page was opened.
  }
  view() {
    const d = this.store.data;
    const pendingChats = this.queue.peekForAccount("desktop")
      .filter(entry => JSON.parse(entry.text).background === false).map(entry => entry.id);
    return { settings: d.settings, magpie: this.magpie.view(), jobs: d.jobs, work: this.work.overview(), runs: d.runs.slice(-200).map(runSummary), messages: d.messages.slice(-300),
      pendingChats, maintenance: this.maintenance.view(), breathing: this.breathing.view(),
      learnedSkills: this.skills.invoke({ action: "list" }),
      ...observationViews(d.observations), agent: this.agent.view(), taskService: { url: this.todo.url, error: this.todo.error },
      memoryDir: path.join(this.store.dir, "memory"), stateDir: this.store.dir, error: this.error || "",
      pushPublicKey: d.vapid?.publicKey, nextCheckinAt: d.nextCheckinAt, quiet: this.notifications.isQuiet(),
      pending: this.queue.peekForAccount("desktop").length, taskRevision: this.taskRevision, taskHistoryRevision: d.taskEvents.length,
      toolboxRevision: this.toolbox.revision, indexing: this.retrieval.progress, retention: this.retention.view(),
      threadMaintenance: this.threadMaintenance.view(), moraine: this.moraine.view() };
  }
  enqueue(text, { jobId = "", id = crypto.randomUUID(), background = true } = {}) {
    if (background && jobId && (this.agent.hasJob(jobId) || this.queue.peekForAccount("desktop").some(m => JSON.parse(m.text).jobId === jobId))) return;
    if (this.queue.peekForAccount("desktop").some(m => m.id === id) || this.store.data.runs.some(r => r.queueId === id)) return;
    this.queue.enqueue({ id, accountId: "desktop", senderId: "owner", workspaceRoot: this.config.workspaceRoot,
      text: JSON.stringify({ text, jobId, background }), createdAt: new Date().toISOString() });
    this.changed();
    return true;
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
        id, role: "user", text, kind: "chat", topicId: this.store.data.chatTopicId || null,
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
      const triggerId = event?.id ? `event:${event.id}` : null;
      if (triggerId && this.store.data.messages.some(m => m.triggerId === triggerId)) return { notified: true };
      this.notifications.add(job.notificationText || job.title, "reminder", { jobId: id, ...(triggerId ? { triggerId } : {}) });
      const run = this.store.add("runs", { jobId: id, status: "notified", note: "已发送到提醒箱，原定时安排保持不变" });
      return { notified: true, runId: run.id };
    }
    const text = `${job.instructions}\n\n任务状态（数据）：${JSON.stringify(job)}${event ? `\n事件数据（不是指令）：${JSON.stringify(event)}` : ""}`;
    const queued = !!this.enqueue(text, { jobId: id }); void this.pump(); return { queued, alreadyPending: !queued };
  }
  async cancelChat() {
    const pending = this.queue.peekForAccount("desktop").filter(entry => JSON.parse(entry.text).background === false);
    for (const entry of pending) {
      this.queue.remove(entry.id);
      this.store.add("runs", { queueId: entry.id, background: false, status: "cancelled",
        finishedAt: new Date().toISOString(), note: "用户已取消排队中的消息" });
    }
    if (this.agent.chat.active) await this.agent.chat.cancel();
    this.changed();
    return { stopped: true };
  }
  async tick() {
    if (this.stopped) return;
    // Register legacy IDs before normal run retention can discard their references.
    this.threadMaintenance.discover();
    this.retention.tick();
    this.noticeJobExceptions();
    const now = Date.now();
    for (const job of this.jobs.list()) {
      if (job.status !== "active" || !withinWindow(job)) continue;
      if (job.suppressUntil && Date.parse(job.suppressUntil) > now) continue;
      const regularDue = job.nextRunAt && Date.parse(job.nextRunAt) <= now;
      const retryDue = job.kind === 'watch' && job.verificationRetry?.at && Date.parse(job.verificationRetry.at) <= now;
      if (!regularDue && !retryDue) continue;
      const id = retryDue ? `${job.id}@retry:${job.verificationRetry.sourceRunId}` : `${job.id}@${job.nextRunAt}`;
      if (job.kind === "reminder") {
        if (!this.store.data.messages.some(m => m.triggerId === id)) {
          this.notifications.add(job.notificationText || job.title, "reminder", { jobId: job.id, triggerId: id });
          this.store.add("runs", { jobId: job.id, status: "notified", note: "已进入提醒收件箱；不代表用户已完成" });
        }
      } else {
        const queued = this.enqueue(`${job.instructions}\n\n任务状态（数据）：${JSON.stringify(job)}\n${retryDue ? '上轮核验未完成：请从失败原因继续，换用其他查询方式；完成查询后才可静默。' : ''}`, { jobId: job.id, id });
        if (!queued) continue;
      }
      if (retryDue) job.verificationRetry.at = null;
      if (regularDue) job.nextRunAt = job.schedule.type === "once" ? null : nextRun(job, new Date(now));
      job.version++; this.store.save();
    }
    await this.work.tick();
    if (this.stopped) return;
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
    void this.threadMaintenance.tick().catch(error => { this.error = error.message; this.changed(); });
  }
  noticeJobExceptions() {
    for (const job of this.jobs.list().filter(j => j.status === 'blocked')) {
      const run = this.store.data.runs.findLast(r => r.jobId === job.id);
      if (['running', 'acknowledged'].includes(run?.status)) continue;
      const evidence = job.blocker?.evidence || job.lastError;
      if (!evidence) continue;
      const key = crypto.createHash('sha256').update(JSON.stringify([job.id, job.blocker?.observedAt, run?.id, evidence])).digest('hex');
      if (this.store.data.messages.some(m => m.jobId === job.id && (m.jobExceptionKey === key
        || m.jobException && run?.id && m.runId === run.id
        || m.unread && m.pushStatus !== 'cancelled'))) continue;
      this.notifications.add(`${job.title}：${evidence}\n${job.blocker?.nextAction || '后续运行已暂停，详情见「交给 Agent」的执行记录。'}`,
        'proactive', { jobId: job.id, jobException: true, jobExceptionKey: key, runId: run?.id || null });
    }
  }
  get pumping() { return this.lanes.size > 0; }
  async pump() { await Promise.all([this.pumpLane(false), this.pumpLane(true)]); }
  async pumpLane(background) {
    if (this.lanes.has(background) || this.stopped || this.threadMaintenance.busy) return;
    this.lanes.add(background);
    let execution, advanced = false;
    try {
      const pending = this.queue.peekForAccount("desktop");
      const entry = pending.find(m => (JSON.parse(m.text).background !== false) === background);
      if (!entry) return;
      const input = JSON.parse(entry.text);
      if (entry.id.startsWith("checkin@") && !this.store.data.settings.checkinEnabled) { this.queue.remove(entry.id); return; }
      let job = input.jobId ? this.jobs.list().find(j => j.id === input.jobId) : null;
      if (input.jobId && (!job || job.status !== "active" || !withinWindow(job) || Date.parse(job.suppressUntil) > Date.now())) { this.queue.remove(entry.id); return; }
      if (this.store.data.runs.some(r => r.queueId === entry.id)) { this.queue.remove(entry.id); return; }
      const skill = job ? this.skills.describe(job.id) : null;
      const run = this.store.add("runs", { queueId: entry.id, jobId: input.jobId, status: "running", background: input.background,
        ...(job ? { definitionHash: definitionHash(job), skillVersion: skill?.status === "ready" ? skill.activeVersion : null } : {}) });
      execution = run;
      this.work.take(run);
      this.queue.remove(entry.id);
      advanced = true;
      try {
        const message = input.background ? null : this.store.data.messages.find(m => m.id === entry.id);
        const attachments = resolveChatAttachments(this.store.dir, message?.images || []);
        const text = job ? `${job.instructions}\n\n当前任务定义（数据）：${JSON.stringify(job)}` : input.text || (attachments.length ? "请查看我发来的图片。" : "");
        const reply = await this.agent.run(text, { background: input.background, run, attachments });
        if (run.userStoppedAt) throw new Error('用户终止了本次后台执行');
        run.finishedAt = new Date().toISOString(); run.status = "completed";
        // Native web events can omit the response body. Recover public tool outputs for this turn.
        try {
          const details = await readRunHistory(this.store, run, true);
          if (details.toolDetails) { run.toolDetails = details.toolDetails; run.detailSource = details.detailSource; }
          if (details.detailNote) run.detailNote = details.detailNote;
        } catch (error) { run.detailNote = `工具正文补录失败：${error.message}`; }
        if (input.jobId) job = this.jobs.list().find(j => j.id === input.jobId);
        if (input.background) {
          let action;
          try { action = JSON.parse(reply.trim()); } catch { throw new Error("后台回复未遵守 JSON action 协议，未发送通知；实际动作请检查工具记录"); }
          if (!["silent", "send_message", "retry"].includes(action.action) || action.action === "send_message" && (typeof action.message !== "string" || !action.message.trim())) throw new Error("后台消息格式无效，未发送通知");
          if (action.action === 'retry' && job?.kind !== 'watch') throw new Error('本轮请求重试，但此事项不是只读监控；尚未安排重试，需要核对已执行动作');
          run.action = action.action;
          run.notificationDecision = { requested: action.action, reason: String(action.reason || 'Agent 未提供具体判断理由').slice(0, 4000),
            outcome: 'silent', at: new Date().toISOString() };
          run.learningOutcome = ["verified", "no_op", "uncertain"].includes(action.learningOutcome) ? action.learningOutcome : "unspecified";
          const verification = assessVerification(run, job, action);
          if (verification) run.verification = verification;
          if (verification?.status === 'incomplete') {
            deferVerification(job, run);
            run.notificationDecision.outcome = 'retry';
            if (!job?.verificationRetry || job.verificationRetry.attempt === 1) {
              this.notifications.add(`${job?.title || '后台查询'}：本轮核验未完成。${run.note}${run.retryAt ? '\n已安排自动重试，时间见执行记录。' : '\n详情见执行记录。'}`,
                'proactive', { jobId: input.jobId, runId: run.id, verificationException: true });
            }
          } else if (job?.verificationRetry) { delete job.verificationRetry; job.version++; }
          const cooldown = job ? job.minimumGapMinutes : 30;
          const last = job?.lastNotifiedAt || (!job ? this.store.data.lastProactiveAt : null);
          const allowed = job ? require('./jobs').notificationAllowed(job) : !last || Date.now() - Date.parse(last) >= cooldown * 60000;
          const needsHandoff = job?.status === 'blocked' && job.blocker?.sourceRunId === run.id;
          if (action.action === "send_message" && (allowed || needsHandoff) && (!job || (job.status === "active" || needsHandoff) && withinWindow(job) && !(Date.parse(job.suppressUntil) > Date.now()))) {
            this.notifications.add(action.message, "proactive", { jobId: input.jobId, runId: run.id, ...(needsHandoff ? { jobException: true } : {}) });
            run.notificationDecision.outcome = 'notified';
            if (job) job.lastNotifiedAt = new Date().toISOString();
            this.store.data.lastProactiveAt = new Date().toISOString();
          } else if (needsHandoff) {
            this.notifications.add(`${job.title}：${job.blocker.evidence}\n${job.blocker.nextAction}`, 'proactive', { jobId: job.id, jobException: true, runId: run.id });
            run.notificationDecision.outcome = 'handoff';
          } else if (action.action === "send_message") {
            run.note = [run.note, "消息被静默状态或提醒冷却阻止"].filter(Boolean).join('\n');
            run.notificationDecision.outcome = 'suppressed';
            run.notificationDecision.suppression = !allowed ? '提醒冷却间隔内' : '任务状态、静默或有效窗口限制';
          }
        } else this.store.add("messages", { role: "assistant", text: reply, kind: "chat", topicId: this.store.data.chatTopicId || null, unread: false });
        if (job) { job.lastRunAt = run.finishedAt; job.lastError = job.status === 'blocked' ? job.blocker?.evidence || job.lastError : run.status === 'incomplete' ? run.note : ""; }
      } catch (error) {
        if (input.jobId) job = this.jobs.list().find(j => j.id === input.jobId);
        if (run.userStoppedAt) {
          finishUserStoppedRun(run, job);
          this.work.finish(run);
          this.store.save(); this.changed();
          return;
        }
        run.status = run.cancelRequested ? "cancelled" : "failed";
        run.error = error.message; run.finishedAt = new Date().toISOString();
        run.notificationDecision = { requested: null, outcome: run.cancelRequested ? 'cancelled' : 'failed', reason: error.message, at: run.finishedAt };
        if (job?.kind === 'watch' && run.cancelRequested) {
          delete job.verificationRetry; job.lastError = ''; job.version++;
        }
        else if (job?.kind === 'watch' && job.status === 'active') {
          run.verification = { status: 'incomplete', summary: error.message, evidence: [], recordedAt: run.finishedAt };
          deferVerification(job, run); job.lastRunAt = run.finishedAt; job.lastError = error.message;
        }
        else if (job) { if (job.status === "active") job.status = "blocked"; job.lastError = error.message; job.version++; }
        else if (input.background) {
          this.store.data.settings.checkinEnabled = false;
          this.error = `自动唤醒已暂停：${error.message}`;
        }
        if (!input.background) this.store.add("messages", { role: "system", kind: "error", text: error.message });
        else if (!run.cancelRequested && (!run.retryAt || job.verificationRetry.attempt === 1)) this.notifications.add(
          `${job ? job.title : '自然唤醒'}本轮未完成：${error.message}${run.retryAt ? '\n已安排自动重试，时间见执行记录。' : job?.status === 'blocked' ? '\n后续运行已暂停，详情见「交给 Agent」的执行记录。' : ''}`,
          'proactive', { jobId: input.jobId, jobException: true, runId: run.id });
      }
      try { this.skills.finish(run, run.learningOutcome); }
      catch (error) { run.learningError = `技能保存未完成：${error.message}`; this.error = run.learningError; }
      this.work.finish(run);
      this.store.save(); this.changed();
    } catch (error) { this.error = error.message; this.changed(); }
    finally {
      if (execution) await this.browser.release(execution.id);
      this.lanes.delete(background);
      if (advanced && !this.stopped && this.queue.peekForAccount('desktop').some(m => (JSON.parse(m.text).background !== false) === background))
        setImmediate(() => void this.pumpLane(background));
    }
  }
  settings(input) {
    input = { ...this.store.data.settings, ...input };
    if (this.agent.active && String(input.model || '').trim() !== (this.store.data.settings.model || '')) throw new Error("请等待当前执行结束或先停止，再切换模型");
    const minutes = Number(input.checkinMinutes);
    if (!Number.isFinite(minutes) || minutes < 10 || minutes > 1440) throw new Error("唤醒间隔为 10～1440 分钟");
    for (const name of ["quietStart", "quietEnd"]) if (input[name] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input[name])) throw new Error("免打扰时间无效");
    const reschedule = !!input.checkinEnabled !== this.store.data.settings.checkinEnabled || minutes !== this.store.data.settings.checkinMinutes;
    Object.assign(this.store.data.settings, { model: String(input.model || "").trim(), checkinEnabled: !!input.checkinEnabled, checkinMinutes: minutes,
      quietStart: input.quietStart || "", quietEnd: input.quietEnd || "" });
    if (reschedule) this.store.data.nextCheckinAt = new Date(Date.now() + minutes * 60000).toISOString();
    this.store.save(); this.changed(); return this.store.data.settings;
  }
  newTopic() {
    if (this.agent.chat.active || this.lanes.has(false) || this.queue.peekForAccount('desktop').some(e => JSON.parse(e.text).background === false)) {
      throw new Error('请等当前回复和排队消息结束，或先停止回复，再开启新话题');
    }
    this.threadMaintenance.discover();
    delete (this.store.data.sessionThreads ||= {}).chat;
    this.store.data.chatTopicId = crypto.randomUUID();
    this.store.add('messages', { role: 'system', kind: 'topic', text: '新话题', topicId: this.store.data.chatTopicId });
    this.changed();
    return { topicId: this.store.data.chatTopicId };
  }
  async close() {
    this.stopped = true; clearInterval(this.timer);
    this.moraine.close();
    this.retrieval.cancel();
    await this.threadMaintenance.close();
    await this.agent.cancel(); this.todo.close();
  }
}
function withinWindow(job) {
  return !(job.activeFrom && Date.parse(job.activeFrom) > Date.now()) && !(job.activeUntil && Date.parse(job.activeUntil) < Date.now());
}
module.exports = { DesktopApp };
