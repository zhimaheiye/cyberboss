const fs = require("fs");
const path = require("path");
const { runToolMcpServer } = require("../tools/mcp-stdio-server");

async function main() {
  const dir = process.argv[2] || process.env.CYBERBOSS_DESKTOP_DIR;
  const endpoint = JSON.parse(fs.readFileSync(path.join(dir, "endpoint.json"), "utf8"));
  const url = new URL(endpoint.url);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("工作台工具仅连接本机");
  async function request(route, body) {
    const timeout = ['cb_maintenance', 'cb_browser'].includes(body?.name) ? 600000 : 45000;
    const response = await fetch(`${url.origin}${route}`, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(timeout), redirect: "error",
      headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "工作台服务不可用");
    return data;
  }
  const catalog = await request("/api/tools");
  runToolMcpServer({ toolHost: { listTools: () => catalog,
    invokeTool: (name, args) => request("/api/tool", { name, args }) } });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
