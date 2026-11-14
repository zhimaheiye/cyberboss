const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isReady } = require('./maintenance');
const ACTIONS = ['navigate','find_tab','snapshot','find','read_page','wait','send_keys','mouse_click','click','fill','evaluate','screenshot','save_as_pdf','list_tabs','list_browser_tabs','attach_tab','close_tab','close_session','network','upload','cdp'];
class BrowserBridge {
  constructor(store, maintenance) { this.store = store; this.maintenance = maintenance; }
  async command({ action, args = {}, session }) {
    if (!ACTIONS.includes(action)) throw new Error('不支持的 Kimi 浏览器动作');
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(session || '')) throw new Error('请提供稳定的任务 session 名称');
    // A cached five-second startup snapshot used to reject healthy connections
    // indefinitely. Refresh before dispatch; recovery cannot replay this action.
    if (this.maintenance.pending) await this.maintenance.pending;
    let status = await this.maintenance.readStatus();
    if (!isReady(status)) {
      const recovery = await this.maintenance.invoke('prepare_browser');
      status = recovery.status;
      if (!recovery.ready) {
        const error = new Error('浏览器连接仍待诊断；本次动作尚未发送。请按 cb_maintenance diagnose 的证据继续排查，不能据此要求用户启用扩展或永久阻塞任务');
        error.code = 'BROWSER_NOT_READY'; throw error;
      }
    }
    const port = Number(status.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Kimi 监听端口无效，请重新准备浏览器');
    const body = JSON.stringify({ action, args, session });
    if (Buffer.byteLength(body, 'utf8') > 256000) throw new Error('单次浏览器请求过大');
    const dir = path.join(this.store.dir, 'browser-requests'); fs.mkdirSync(dir, { recursive:true });
    const file = path.join(dir, `request-${crypto.randomUUID()}.json`);
    // Kimi's Windows file-body requirement is preserved; UTF-8 never goes
    // through a shell argument, and no model/file-patch round trip is needed.
    fs.writeFileSync(file, body, { encoding:'utf8', flag:'wx', mode:0o600 });
    this.maintenance.browserBusy = (this.maintenance.browserBusy || 0) + 1;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/command`, { method:'POST', redirect:'error',
        headers:{ 'Content-Type':'application/json' }, body:fs.readFileSync(file), signal:AbortSignal.timeout(90000) });
      const result = await response.json();
      if (!response.ok || result?.ok !== true) throw new Error(`Kimi ${action}: ${result?.error?.message || result?.error?.code || `HTTP ${response.status}`}`);
      return result;
    } catch (error) {
      // Never automatically retry a possibly side-effecting click/fill/etc.
      if (error.name === 'TimeoutError') throw new Error(`Kimi ${action} 超时，结果未确认；未自动重试，请先读取页面核对`);
      throw error;
    } finally { this.maintenance.browserBusy--; fs.rmSync(file, { force:true }); }
  }
}
module.exports = { BrowserBridge, ACTIONS };
