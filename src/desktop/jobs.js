const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const YAML = require("yaml");
const { RRule } = require("rrule");

const KINDS = ["reminder", "watch", "operation", "opportunity"];
const STATUSES = ["draft", "active", "paused", "blocked", "done"];
function nextRun(job, after = new Date()) {
  const s = job.schedule || {};
  if (s.type === "manual" || !s.type) return null;
  if (s.type === "once") {
    if (!Number.isFinite(Date.parse(s.at))) throw new Error("一次性任务需要有效日期");
    return new Date(s.at).toISOString();
  }
  if (s.type !== "recurring") throw new Error("未知调度类型");
  const zone = job.timezone || "Asia/Shanghai";
  new Intl.DateTimeFormat("en", { timeZone: zone }).format();
  const date = s.startDate || new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(job.createdAt));
  const [y, m, d] = date.split("-").map(Number);
  const [h, minute] = String(s.time || "09:00").split(":").map(Number);
  if (!y || !m || !d || !Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("调度日期或时间无效");
  const opts = RRule.parseString(String(s.rrule || ""));
  if (opts.interval != null && (!Number.isInteger(opts.interval) || opts.interval < 1 || opts.interval > 10000)) throw new Error("周期间隔必须为 1～10000 的整数");
  if (opts.freq == null || opts.freq === RRule.SECONDLY || (opts.freq === RRule.MINUTELY && (opts.interval || 1) < 10)) throw new Error("检查间隔至少 10 分钟；请提供有效 RRULE");
  const rule = new RRule({ ...opts, dtstart: new Date(Date.UTC(y, m - 1, d, h, minute)), tzid: zone });
  return rule.after(after, false)?.toISOString() || null;
}

class JobService {
  constructor(store) { this.store = store; }
  list() { return this.store.data.jobs; }
  save(input) {
    const existing = input.id ? this.list().find(j => j.id === input.id) : null;
    if (input.id && !existing) throw new Error("任务不存在");
    if (existing && input.version !== existing.version) throw new Error("任务已经被更新，请刷新后再保存");
    const createdAt = existing?.createdAt || new Date().toISOString();
    const job = { ...existing, id: existing?.id || crypto.randomUUID(), createdAt,
      title: String(input.title ?? existing?.title ?? "").trim(),
      kind: input.kind ?? existing?.kind ?? "watch", status: input.status ?? existing?.status ?? "draft",
      instructions: String(input.instructions ?? existing?.instructions ?? ""),
      notificationText: String(input.notificationText ?? existing?.notificationText ?? ""),
      timezone: input.timezone ?? existing?.timezone ?? "Asia/Shanghai",
      schedule: input.schedule ?? existing?.schedule ?? { type: "manual" },
      suppressUntil: input.suppressUntil ?? existing?.suppressUntil ?? "",
      activeFrom: input.activeFrom ?? existing?.activeFrom ?? "",
      activeUntil: input.activeUntil ?? existing?.activeUntil ?? "",
      minimumGapMinutes: Number(input.minimumGapMinutes ?? existing?.minimumGapMinutes ?? 1440),
      contexts: String(input.contexts ?? existing?.contexts ?? ""),
      blocker: (input.status ?? existing?.status) === 'blocked' ? input.blocker ?? existing?.blocker ?? null : null,
      taskId: String(input.taskId ?? existing?.taskId ?? ""),
      acknowledgedValues: existing?.acknowledgedValues || [], version: (existing?.version || 0) + 1,
    };
    if (!job.title || job.title.length > 300 || job.instructions.length > 50000) throw new Error("请填写标题，执行说明最多 5 万字");
    if (!KINDS.includes(job.kind) || !STATUSES.includes(job.status)) throw new Error("任务类型或状态不正确");
    if (!Number.isFinite(job.minimumGapMinutes) || job.minimumGapMinutes < 0) throw new Error("提醒间隔无效");
    if (job.suppressUntil && !Number.isFinite(Date.parse(job.suppressUntil))) throw new Error("静默日期无效");
    for (const key of ["activeFrom", "activeUntil"]) if (job[key] && !Number.isFinite(Date.parse(job[key]))) throw new Error("有效窗口日期无效");
    const calculated = nextRun(job);
    const changed = !existing || JSON.stringify(existing.schedule) !== JSON.stringify(job.schedule) || existing.timezone !== job.timezone || existing.status !== job.status;
    job.nextRunAt = changed ? calculated : existing.nextRunAt;
    if (existing) Object.assign(existing, job); else this.list().push(job);
    this.store.save();
    return job;
  }
  acknowledge({ id, value, until, note = "用户确认已处理" }) {
    const job = this.list().find(j => j.id === id);
    if (!job) throw new Error("任务不存在");
    if (value) {
      if (!job.acknowledgedValues.some(v => v.value === value)) job.acknowledgedValues.push({ value, note, at: new Date().toISOString() });
    } else if (until) {
      if (!Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now()) throw new Error("本期完成需要未来的下一周期开始时间");
      job.suppressUntil = new Date(until).toISOString();
    } else if (job.schedule.type === "recurring" || job.kind === "watch") {
      throw new Error("长期任务请指定已处理的具体值或下期开始时间；不会把整个监控误标完成");
    } else job.status = "done";
    job.version++;
    for (const message of this.store.data.messages.filter(m => m.jobId === id && m.unread)) {
      message.unread = false; message.resolvedAt = new Date().toISOString(); message.pushStatus = "cancelled";
    }
    this.store.add("runs", { jobId: id, status: "acknowledged", note, value, until });
    return job;
  }
  importHub(root) {
    const results = [];
    for (const [relative, key] of [["reminders/reminders.yaml", "reminders"], ["automations/jobs.yaml", "jobs"]]) {
      const filename = path.join(root, relative);
      const doc = YAML.parse(fs.readFileSync(filename, "utf8"));
      for (const source of doc[key] || []) {
        const sourceKey = `personal-hub:${key}:${source.id}`;
        if (this.list().some(j => j.sourceKey === sourceKey)) { results.push({ title: source.title, skipped: true }); continue; }
        const rawSchedule = source.fallback?.schedule || source.schedule || { type: "manual" };
        const schedule = { ...rawSchedule, time: rawSchedule.time || `09:${String(rawSchedule.minute || 0).padStart(2, "0")}` };
        if (schedule.type === "none") schedule.type = "manual";
        if (schedule.type === "once" && typeof schedule.at === "string" && !/(Z|[+-]\d{2}:\d{2})$/i.test(schedule.at)) {
          const zone = source.timezone || rawSchedule.timezone || doc.defaults?.timezone || "Asia/Shanghai";
          if (zone === "Asia/Shanghai") schedule.at += "+08:00";
          else schedule.type = "manual"; // Preserve the original ambiguous value in sourceDefinition.
        }
        if (source.fallback?.enabled === false) schedule.type = "manual";
        const kind = key === "jobs" ? "operation" : /监控|检查/.test(source.title) ? "watch" : "reminder";
        const job = this.save({ title: source.title, kind, notificationText: source.fallback?.message || source.title, status: ["paused", "blocked", "done"].includes(source.status) ? source.status : "draft",
          instructions: [source.context, source.fallback?.message, source.execution?.description,
            source.execution?.safety_notes, source.source_of_truth ? `执行手册（先读取再执行）：${JSON.stringify(source.source_of_truth)}` : ""].filter(Boolean).join("\n\n"),
          contexts: (source.proactive?.contexts || []).join("\n"), schedule,
          timezone: source.timezone || doc.defaults?.timezone || "Asia/Shanghai", suppressUntil: source.suppress_until || "",
          activeFrom: source.proactive?.active_from || "", activeUntil: source.proactive?.active_until || (source.expires_on ? `${source.expires_on}T23:59:59+08:00` : ""),
          minimumGapMinutes: durationMinutes(source.proactive?.minimum_gap) });
        const saved = this.list().find(j => j.id === job.id);
        Object.assign(saved, { sourceKey, sourceFile: filename, sourceStatus: source.status, sourceDefinition: source,
          acknowledgedValues: source.tracking?.acknowledged_values || [],
          importNote: "待核对时间、工具、执行权限和旧平台负责人后接管；不修改源仓库或其它平台。" });
        this.store.save();
        results.push({ id: job.id, title: job.title, status: job.status });
      }
    }
    return results;
  }
}
function durationMinutes(value) {
  const match = /^(\d+)\s*(m|h|d)$/.exec(String(value || ""));
  return match ? Number(match[1]) * ({ m: 1, h: 60, d: 1440 }[match[2]]) : 1440;
}
module.exports = { JobService, nextRun };
