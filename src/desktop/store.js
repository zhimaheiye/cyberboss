const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

function finishUserStoppedRun(run, job) {
  run.status = 'cancelled';
  run.finishedAt = new Date().toISOString();
  run.note = '用户终止了本次后台执行';
  run.notificationDecision = { requested: null, outcome: 'cancelled', reason: run.note, at: run.finishedAt };
  require('./run-progress').finishProgress(run, 'cancelled');
  if (job?.verificationRetry) { delete job.verificationRetry; job.version++; }
}

class DesktopStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "desktop.json");
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : {
      version: 1, jobs: [], runs: [], messages: [], observations: [], subscriptions: [],
      settings: { model: "", checkinEnabled: true, checkinMinutes: 30, quietStart: "23:30", quietEnd: "08:00" },
    };
    this.data.apiToken ||= crypto.randomBytes(32).toString("hex");
    // Never automatically replay a possibly side-effecting interrupted run.
    for (const run of this.data.runs.filter(r => r.status === "running")) {
      if (run.userStoppedAt) {
        finishUserStoppedRun(run, this.data.jobs.find(j => j.id === run.jobId));
        continue;
      }
      run.status = "interrupted";
      run.error = "进程退出，执行结果尚未确认；请检查记录后再运行。";
      require("./run-progress").finishProgress(run);
      const job = this.data.jobs.find(j => j.id === run.jobId);
      if (job?.kind === 'watch' && job.status === 'active') {
        run.verification = { status: 'incomplete', summary: '进程退出，信息核验中断；稍后重新查询', evidence: [] };
        require('./verification').deferVerification(job, run);
        job.lastError = run.verification.summary;
      } else if (job) { if (job.status === "active") job.status = "blocked"; job.lastError = run.error; }
    }
    this.save();
  }
  save() { writeJson(this.file, this.data); }
  add(collection, value) {
    const record = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...value };
    this.data[collection].push(record);
    this.save();
    return record;
  }
  memory(args) {
    const dir = path.join(this.dir, "memory");
    if (args.action === "list" || args.action === "search") {
      const query = String(args.query || "").toLocaleLowerCase();
      return fs.readdirSync(dir).filter(name => name.endsWith(".md")).map(name => {
        const text = fs.readFileSync(path.join(dir, name), "utf8");
        const at = text.toLocaleLowerCase().indexOf(query);
        return { name, text, at };
      }).filter(x => !query || x.at >= 0 || x.name.toLocaleLowerCase().includes(query))
        .slice(0, 100).map(x => ({ name: x.name, preview: x.text.slice(Math.max(0, x.at - 80), Math.max(0, x.at - 80) + 800) }));
    }
    const name = String(args.name || "");
    if (!/^[^<>:"/\\|?*\x00-\x1f]{1,120}\.md$/u.test(name) || name.includes("..")) throw new Error("记忆文件名必须是普通的 .md 文件名");
    const file = path.join(dir, name);
    if (args.action === "read") return { name, text: fs.readFileSync(file, "utf8") };
    if (args.action === 'rename' || args.action === 'trash') {
      if (args.expectedText !== fs.readFileSync(file, 'utf8')) throw new Error('笔记已变化，请重新读取后操作');
      if (args.action === 'rename') {
        const newName = String(args.newName || '');
        if (!/^[^<>:"/\\|?*\x00-\x1f]{1,120}\.md$/u.test(newName) || newName.includes('..')) throw new Error('请填写有效的 .md 文件名');
        if (newName === name) return { name, text:args.expectedText };
        const target = path.join(dir, newName);
        if (fs.existsSync(target)) throw new Error('同名笔记已存在');
        fs.renameSync(file, target);
        return { name:newName, text:args.expectedText };
      }
      const trashDir = path.join(dir, '.trash');
      fs.mkdirSync(trashDir, { recursive:true });
      fs.renameSync(file, path.join(trashDir, crypto.randomUUID() + '-' + name));
      return { name, trashed:true };
    }
    if (args.action !== "write") throw new Error("未知记忆操作");
    const text = String(args.text || "");
    if (text.length > 200000) throw new Error("单份记忆最多 20 万字");
    const exists = fs.existsSync(file);
    if (exists && args.expectedText !== fs.readFileSync(file, "utf8")) throw new Error("记忆已存在或已变化，请重新读取再保存");
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.renameSync(temp, file);
    return { name, saved: true };
  }
}
module.exports = { DesktopStore, writeJson, finishUserStoppedRun };
