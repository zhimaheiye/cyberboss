const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { writeJson } = require("./store");

class OpenTodo {
  constructor(dir, port = 4319) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("OpenTodo 端口无效");
    this.dir = dir;
    this.url = `http://127.0.0.1:${port}`;
    this.port = port;
    this.credentialsFile = path.join(dir, "opentodo-credentials.json");
    this.credentials = fs.existsSync(this.credentialsFile) ? JSON.parse(fs.readFileSync(this.credentialsFile, "utf8")) : null;
    this.child = null;
    this.error = "任务服务尚未启动";
  }
  async start() {
    const binary = path.resolve(__dirname, "../../third_party/opentodo/v1.4.2/opentodo-windows-amd64.exe");
    if (!fs.existsSync(binary)) throw new Error("缺少 OpenTodo，请先运行 npm run desktop:install");
    const dataDir = path.join(this.dir, "opentodo");
    fs.mkdirSync(dataDir, { recursive: true });
    this.child = spawn(binary, [], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: {
      ...process.env, OPENTODO_ADDR: `127.0.0.1:${this.port}`, OPENTODO_DATA_DIR: dataDir,
      OPENTODO_BASE_URL: this.url, OPENTODO_MCP: "true", OPENTODO_MCP_WRITES: "true", OPENTODO_MAPS: "off",
    } });
    let exitError = null;
    this.child.stderr.on("data", () => {});
    this.child.on("error", error => { exitError = error; this.error = error.message; });
    this.child.on("exit", code => { exitError = new Error(`OpenTodo 已退出 (${code})，请检查端口 ${this.port} 是否被占用`); this.error = exitError.message; });
    let status;
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (exitError) throw exitError;
      try { status = (await this.request("/api/v1/auth/status", "GET", undefined, undefined, 1000)).data; break; } catch {}
    }
    if (!status) throw new Error("OpenTodo 启动超时");
    if (!this.credentials) {
      if (!status.setupRequired) throw new Error("此端口已有非托管账户；不会接管或覆盖，请更换 CYBERBOSS_OPENTODO_PORT");
      this.credentials = { email: "owner@cyberboss.local", password: crypto.randomBytes(32).toString("base64url") };
      writeJson(this.credentialsFile, this.credentials);
    }
    const route = status.setupRequired ? "register" : "login";
    const login = await this.request(`/api/v1/auth/${route}`, "POST", { email: this.credentials.email, password: this.credentials.password });
    this.cookie = login.cookie;
    if (!this.cookie) throw new Error("OpenTodo 未返回本地会话；请在任务服务中处理账户登录");
    await this.request("/api/v1/settings/mcp", "PUT", { enabled: true, writes_enabled: true }, this.cookie);
    await this.request("/api/v1/me/agent-access", "PUT", { allow_writes: true }, this.cookie);
    if (!this.credentials.token) {
      const result = await this.request("/api/v1/tokens", "POST", { name: "CyberBoss local agent", scope: "agent" }, this.cookie);
      if (!result.data.secret) throw new Error("OpenTodo 创建令牌失败");
      this.credentials.token = result.data.secret;
      writeJson(this.credentialsFile, this.credentials);
    }
    this.error = "";
  }
  async request(route, method = "GET", body, cookie, timeout = 15000) {
    const response = await fetch(this.url + route, { method, redirect: "error", signal: AbortSignal.timeout(timeout),
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(`OpenTodo: ${data.error?.message || response.status}`);
    return { data, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  async browserSession() {
    if (this.error) throw new Error(this.error);
    const login = await this.request("/api/v1/auth/login", "POST", { email: this.credentials.email, password: this.credentials.password });
    if (!login.cookie) throw new Error("无法建立任务页面会话");
    return login.cookie;
  }
  async rpc(method, params = {}) {
    if (this.error) throw new Error(this.error);
    const response = await fetch(`${this.url}/mcp`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${this.credentials.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    });
    const text = await response.text();
    let packet;
    try {
      packet = response.headers.get("content-type")?.includes("text/event-stream")
        ? text.split("\n").filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5))).find(p => p.result || p.error)
        : JSON.parse(text);
    } catch { throw new Error(`OpenTodo 返回非 JSON 响应 (${response.status})`); }
    if (!response.ok || packet?.error) throw new Error(packet?.error?.message || `OpenTodo HTTP ${response.status}`);
    return packet.result;
  }
  async tools() { return (await this.rpc("tools/list")).tools; }
  async call(name, args) {
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(result.content?.map(c => c.text || "").join("\n") || "任务操作失败");
    if (result.structuredContent) return result.structuredContent;
    const text = result.content?.find(c => c.type === "text")?.text || "{}";
    try { return JSON.parse(text); } catch { return { text }; }
  }
  close() { this.child?.kill(); }
}
module.exports = { OpenTodo };
