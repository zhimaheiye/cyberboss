const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { writeJson } = require('./store');
const { inspectBrowserHost, launchBrowserProfile } = require('./browser-host');

// The owner's grant is a local data file, never an implicit permission for
// other installations. Only fixed Kimi commands and existing browser profiles
// are used; no arbitrary command supplied by the model is executed.
const DEFAULT_POLICY = { enabled: false, upgrade: true, restartForBrowser: true, scope: 'kimi-webbridge' };
class Maintenance {
  constructor(store, changed) {
    this.store = store; this.changed = changed; this.pending = null;
    store.data.maintenance ||= { records: [], status: null };
    this.data = store.data.maintenance;
    this.policyFile = path.join(store.dir, 'maintenance-policy.json');
    this.data.policy = fs.existsSync(this.policyFile) ? JSON.parse(fs.readFileSync(this.policyFile, 'utf8')) : { ...DEFAULT_POLICY };
    for (const record of this.data.records.filter(r => r.status === 'running')) {
      record.status = 'interrupted'; record.error = '工作台退出，维护结果待重新读取状态确认；不会自动重放升级。';
    }
    this.binary = path.join(os.homedir(), '.kimi-webbridge', 'bin', process.platform === 'win32' ? 'kimi-webbridge.exe' : 'kimi-webbridge');
    store.save();
  }
  view() { return { ...this.data, records: this.data.records.slice(-30), busy: !!this.pending }; }
  async readStatus() {
    const status = JSON.parse(await this.command(['status']));
    if (typeof status.running !== 'boolean') throw new Error('Kimi 返回的状态格式无效');
    this.data.status = status; this.data.checkedAt = new Date().toISOString();
    if (status.extension_id) this.data.lastExtensionId = status.extension_id;
    this.store.save(); this.changed();
    return status;
  }
  command(args) {
    if (!fs.existsSync(this.binary)) throw new Error('本机未找到 kimi-webbridge，请安装后再使用浏览器维护');
    return new Promise((resolve, reject) => execFile(this.binary, args, {
      windowsHide: true, timeout: args[0] === 'upgrade' ? 240000 : 45000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => error ? reject(new Error((stderr || stdout || error.message).slice(-4000))) : resolve(stdout.trim())));
  }
  async invoke(action) {
    if (action === 'policy') return this.view();
    if (action === 'status') {
      const status = await this.readStatus();
      return { status, checkedAt: this.data.checkedAt, ready: isReady(status) };
    }
    if (!['check', 'prepare_browser', 'diagnose'].includes(action)) throw new Error('未知维护操作');
    if (this.browserBusy && action !== 'diagnose') throw new Error('浏览器动作仍在执行，暂不重启或升级守护进程；先等当前动作结果');
    if (this.pending) {
      if (this.pendingAction === action || action === 'check') return this.pending;
      await this.pending; return this.invoke(action);
    }
    this.pendingAction = action;
    this.pending = this.perform(action);
    this.changed();
    try { return await this.pending; } finally { this.pending = null; this.changed(); }
  }
  async perform(action) {
    const record = { id: require('crypto').randomUUID(), action, createdAt: new Date().toISOString(), status: 'running', steps: [] };
    this.data.records.push(record); this.data.records = this.data.records.slice(-100);
    this.store.save();
    const run = async args => {
      try { const output = await this.command(args); record.steps.push({ at: new Date().toISOString(), command: args.join(' '), output: output.slice(-6000) }); this.store.save(); this.changed(); return output; }
      catch (error) { record.steps.push({ at: new Date().toISOString(), command: args.join(' '), output: error.message }); this.store.save(); this.changed(); throw error; }
    };
    const readStatus = async () => {
      const status = JSON.parse(await run(['status']));
      if (typeof status.running !== 'boolean') throw new Error('Kimi 返回的状态格式无效');
      this.data.status = status; this.data.checkedAt = new Date().toISOString(); return status;
    };
    try {
      let status = await readStatus(), restarted = false;
      const policy = this.data.policy;
      const waitForConnection = async () => {
        const deadline = Date.now() + 30000;
        record.note = '等待浏览器扩展重连（最多 30 秒），尚未判定需要人工处理';
        this.store.save(); this.changed();
        while (status.running && !status.extension_connected && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 2000)); status = await readStatus();
        }
      };
      if (action === 'prepare_browser' && policy.enabled && policy.restartForBrowser && !status.running) {
        await run(['start']); restarted = true; status = await readStatus();
      }
      // Browser service workers back off after reboot. Wait for their handshake
      // before choosing an upgrade target or treating the connection as broken.
      if (action === 'prepare_browser' && status.running && !status.extension_connected) await waitForConnection();
      if ((action === 'prepare_browser' || action === 'diagnose') && !status.extension_connected) {
        // Remember the identity from an actual handshake, not a guessed store ID.
        let extensionId = status.extension_id || this.data.lastExtensionId;
        if (!extensionId) {
          for (const previous of [...this.data.records].reverse()) {
            const matched = [...previous.steps].reverse().find(step => step.command === 'status' && /"extension_connected":true/.test(step.output));
            if (matched) { try { extensionId = JSON.parse(matched.output).extension_id; } catch {} }
            if (extensionId) break;
          }
        }
        try {
          record.browserHost = await inspectBrowserHost(extensionId);
          const candidates = record.browserHost.profiles || [];
          if (action === 'prepare_browser' && policy.enabled && policy.restartForBrowser && candidates.length === 1
              && !candidates[0].browserRunning && candidates[0].executable) {
            await launchBrowserProfile(candidates[0]);
            record.steps.push({ at: new Date().toISOString(), command: 'launch installed browser profile',
              output: `${candidates[0].browser} / ${candidates[0].profile}；保留现有配置，未关闭任何窗口` });
            await waitForConnection();
          }
        } catch (error) { record.browserHost = { error: error.message }; }
        this.store.save(); this.changed();
      }
      if (action !== 'diagnose' && policy.enabled && policy.upgrade && (status.update_available || status.version_mismatch)) {
        await run(['upgrade']);
        restarted = true; status = await readStatus();
      }
      if (action !== 'diagnose' && policy.enabled && policy.upgrade && status.skill_mismatch) {
        const version = status.skill_mismatch.extension_version;
        if (!/^v?\d+\.\d+\.\d+$/.test(version || '')) throw new Error('扩展返回了无效技能版本，未执行同步');
        await run(['install-skill', '--version', version.replace(/^v/, ''), '-y']);
        status = await readStatus();
      }
      if (action === 'prepare_browser' && policy.enabled && policy.restartForBrowser && !restarted && !status.extension_connected) {
        await run([status.running ? 'restart' : 'start']);
        restarted = true; status = await readStatus();
      }
      if (restarted && status.running && !status.extension_connected) await waitForConnection();
      if (action === 'diagnose' || action === 'prepare_browser' && !isReady(status)) {
        // Daemon logs also contain telemetry headers. Retain only connection
        // lifecycle evidence, never full raw logs or request bodies.
        try {
          const logs = await this.command(['logs', '-n', '100']);
          record.steps.push({ at: new Date().toISOString(), command: 'logs -n 100 (connection events only)',
            output: logs.split(/\r?\n/).filter(line => /\[ws\]|\[agent-extension-daemon\].*listening/.test(line)).slice(-20).join('\n').slice(-6000) });
        } catch (error) { record.steps.push({ at: new Date().toISOString(), command: 'logs', output: error.message }); }
        status = await readStatus();
      }
      this.data.status = status; this.data.checkedAt = new Date().toISOString();
      if (status.extension_id) this.data.lastExtensionId = status.extension_id;
      record.status = 'completed'; record.note = status.extension_connected ? '守护进程与浏览器扩展已连接' : status.running ? '守护进程已启动，等待浏览器扩展连接' : '守护进程未运行';
      if (status.version_mismatch || status.skill_mismatch) record.note += '；版本仍未对齐，请查看状态，不会循环重试';
      else if (status.update_available) record.note += '；仍有更新提示，以扩展兼容版本为准，不重复升级';
      record.recovery = isReady(status) ? { state: 'ready' } : {
        state: 'needs_diagnosis', humanRequired: false,
        reason: '连接状态不能证明扩展被禁用，也不能证明必须由用户处理',
        nextActions: ['读取最新 status，不使用 policy 内的历史状态判断连接',
          '检查实际浏览器进程、安装扩展的配置文件与扩展界面；使用可用的本机工具恢复原有连接',
          '检查连接地址、版本和日志；不关闭用户浏览器，不重装或清空配置',
          '仅当工具或界面证明人工门槛时记录具体证据；暂时离线且未执行业务动作时保留周期调度'],
      };
      return { ...this.view(), busy: false, ready: isReady(status), recovery: record.recovery };
    } catch (error) { record.status = 'failed'; record.error = error.message; throw error; }
    finally { record.finishedAt = new Date().toISOString(); this.store.save(); this.changed(); }
  }
  setPolicy(enabled) {
    const policy = { ...this.data.policy, enabled: enabled === true, updatedAt: new Date().toISOString() };
    if (policy.enabled && !policy.grantedAt) policy.grantedAt = policy.updatedAt;
    writeJson(this.policyFile, policy); this.data.policy = policy;
    this.store.save(); this.changed(); return this.view();
  }
}
function isReady(status) { return !!(status?.running && status.extension_connected && !status.version_mismatch && !status.skill_mismatch); }
module.exports = { Maintenance, isReady };
