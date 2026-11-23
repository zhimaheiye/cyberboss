const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const launcher = path.join(__dirname, 'moraine-host.py');
const url = 'http://127.0.0.1:4790';

function installation() {
  const dir = path.resolve(process.env.CYBERBOSS_MORAINE_DIR || (process.env.CYBERBOSS_DESKTOP_DIR
    ? path.join(process.env.CYBERBOSS_DESKTOP_DIR, 'moraine') : path.join(__dirname, '../../data/moraine')));
  const python = path.join(dir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return { dir, python };
}

class Moraine {
  constructor(changed) {
    Object.assign(this, installation());
    this.changed = changed;
    this.status = 'offline';
    this.error = '';
    this.recallError = '';
  }
  view() {
    return { status: this.status, error: this.error || this.recallError, url, dir: this.dir };
  }
  mcpConfig() {
    if (this.status !== 'ready') return null;
    return { name: 'moraine', command: this.python, args: ['-I', '-X', 'utf8', launcher, 'mcp', this.dir],
      toolNames: ['memory_search', 'memory_get', 'layered_recall', 'candidate_list', 'candidate_add'] };
  }
  accessToken() {
    return fs.readFileSync(path.join(this.dir, 'access-token'), 'utf8').trim();
  }
  start() {
    if (this.stopped || this.child) return;
    if (!fs.existsSync(this.python)) {
      this.status = 'missing'; this.changed(); return;
    }
    this.error = ''; this.recallError = ''; this.status = 'starting';
    try {
      try {
        fs.writeFileSync(path.join(this.dir, 'access-token'), crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const child = spawn(this.python, ['-I', '-X', 'utf8', launcher, 'serve', this.dir],
        { cwd: this.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      // Let the first Codex turn see the server on a cold start, with a
      // bounded wait so a stalled Python import cannot hold up a chat.
      let release;
      this.startup = new Promise(resolve => {
        const timer = setTimeout(resolve, 3000);
        release = () => { clearTimeout(timer); resolve(); };
      });
      let lastError = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { if (this.status === 'starting') lastError = (lastError + chunk).slice(-1600); });
      createInterface({ input: child.stdout }).on('line', line => {
        if (line === 'ready' && this.child === child) {
          this.status = 'ready'; release(); this.changed();
        }
      });
      child.once('error', error => { lastError = error.message; });
      child.once('close', code => {
        release();
        if (this.child !== child) return;
        this.child = null; this.status = 'offline';
        this.error = lastError.trim().split(/\r?\n/).at(-1) || `进程已退出（${code}）`;
        this.changed();
      });
    } catch (error) { this.status = 'offline'; this.error = error.message; }
    this.changed();
  }
  async prepare(message, recent) {
    if (this.status !== 'ready' || !message?.trim()) return '';
    try {
      const response = await fetch(`${url}/api/host/turn/prepare`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2500),
        headers: { Authorization: `Bearer ${this.accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.slice(0, 2000), recent_messages: recent.slice(-2).map(m => m.text.slice(-1500)), include_history: false }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { prompt_context } = await response.json();
      if (typeof prompt_context !== 'string') throw new Error('缺少召回正文');
      this.recallError = '';
      return prompt_context.slice(0, 8000);
    } catch (error) { this.recallError = `本轮自动召回失败：${error.message}`; return ''; }
  }
  close() {
    this.stopped = true;
    this.child?.stdin.end();
  }
}
module.exports = { Moraine, installation };
