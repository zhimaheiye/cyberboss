const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
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
      run.status = "interrupted";
      run.error = "进程退出，执行结果尚未确认；请检查记录后再运行。";
      require("./run-progress").finishProgress(run);
      const job = this.data.jobs.find(j => j.id === run.jobId);
      if (job) { if (job.status === "active") job.status = "blocked"; job.lastError = run.error; }
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
module.exports = { DesktopStore, writeJson };
