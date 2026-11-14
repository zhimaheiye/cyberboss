const http = require("http");
const fs = require("fs");
const path = require("path");
const { DesktopApp } = require("./app");
const { writeJson } = require("./store");
const { CHAT_BODY_LIMIT, readChatImage } = require("./chat-images");
const { compileFrontend } = require("./frontend");
const { readRunHistory } = require("./run-history");

async function startDesktop(config) {
  // rrule's floating wall-clock dates are evaluated from a stable UTC host zone.
  process.env.TZ = "UTC";
  const port = Number(process.env.CYBERBOSS_DESKTOP_PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("工作台端口无效");
  const origin = `http://127.0.0.1:${port}`;
  const dir = path.resolve(process.env.CYBERBOSS_DESKTOP_DIR || path.join(__dirname, "../../data/desktop"));
  const publicDir = path.resolve(__dirname, "../../web");
  const frontend = await compileFrontend();
  const clients = new Set();
  let app, notifyTimer;
  const changed = () => {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      for (const client of clients) client.write(`data: ${Date.now()}\n\n`);
    }, 250);
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${port}`) return json(res, 403, { error: "仅接受本机工作台地址" });
      if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: "拒绝跨站请求" });
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if (!app) return json(res, 503, { error: "工作台正在启动" });
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith("/api/")) {
        const token = app.store.data.apiToken;
        const auth = req.headers.authorization === `Bearer ${token}`;
        const cookie = String(req.headers.cookie || "").split(/;\s*/).includes(`cyberboss_desktop=${token}`);
        const imageRequest = req.method === "GET" && url.pathname === "/api/chat-image";
        if (!auth && (!cookie || (!imageRequest && url.pathname !== "/api/events" && req.headers["x-cyberboss"] !== "desktop"))) return json(res, 403, { error: "请从本机工作台页面访问" });
        if (imageRequest) {
          res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
          try {
            const image = await readChatImage(app.store.dir, url.searchParams.get("id"));
            res.writeHead(200, { "Content-Type": image.type, "Content-Length": image.bytes.length });
            return res.end(image.bytes);
          } catch (error) {
            if (error.code === "ENOENT") return json(res, 404, { error: "图片已不在本机" });
            throw error;
          }
        }
        if (url.pathname === "/api/events" && req.method === "GET") {
          if (!auth && req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return json(res, 403, { error: "拒绝跨站订阅" });
          res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
          res.write("retry: 3000\ndata: ready\n\n"); clients.add(res);
          const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 20000);
          req.on("close", () => { clearInterval(heartbeat); clients.delete(res); }); return;
        }
        if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, app.view());
        if (req.method === "GET" && url.pathname === "/api/answer-book") return json(res, 200, app.answerBook.view());
        if (req.method === "GET" && url.pathname === "/api/breathing/reminders") return json(res, 200, app.breathing.reminders());
        if (req.method === "GET" && url.pathname === "/api/notifications/display") {
          const message = app.store.data.messages.find(m => m.id === url.searchParams.get("id"));
          return json(res, 200, { allowed: Boolean(message?.unread && !message.breathingSessionId
            && ["reminder", "proactive"].includes(message.kind) && message.pushStatus !== "cancelled"
            && !app.breathing.current()) });
        }
        if (req.method === "GET" && url.pathname === "/api/run") {
          const run = app.store.data.runs.find(run => run.id === url.searchParams.get("id"));
          return json(res, 200, readRunHistory(app.store, run) || null);
        }
        if (req.method === "GET" && url.pathname === "/api/message") return json(res, 200, app.store.data.messages.find(m => m.id === url.searchParams.get("id")) || null);
        if (req.method === "GET" && url.pathname === "/api/tools") return json(res, 200, app.tools.listTools());
        if (req.method !== "POST") return json(res, 405, { error: "此操作需要 POST" });
        const body = await readBody(req, url.pathname === "/api/chat" ? CHAT_BODY_LIMIT : undefined);
        let result;
        switch (url.pathname) {
          case "/api/answer-book": return json(res, 200, await app.answerBook.update(body));
          case "/api/chat": result = app.chat(body.text, body.images, body.requestId); break;
          case "/api/maintenance":
            if (["check", "prepare_browser"].includes(body.action) && app.agent.active) throw new Error("Agent 正在执行任务；请让它在任务中自行维护，或等本轮结束后手动操作");
            if (body.action === "set_policy") result = app.maintenance.setPolicy(body.enabled);
            else result = await app.maintenance.invoke(body.action);
            break;
          case "/api/chat/cancel": result = await app.cancelChat(); break;
          case "/api/cancel": await app.agent.cancel(); result = { stopped: true }; break;
          case "/api/approval": await app.agent.approve(body.id, body.accept === true, body.answers); result = { answered: true }; break;
          case "/api/login": result = await app.agent.login(); break;
          case "/api/models": result = await app.agent.refreshModels(); break;
          case "/api/settings": result = app.settings(body); break;
          case "/api/breathing":
            result = app.breathing.update(body);
            if (body.action === "progress") return json(res, 200, result);
            break;
          case "/api/tool":
            result = await app.tools.invokeTool(body.name, body.args);
            if (body.name?.startsWith("opentodo_") && !/^opentodo_(list|get|search|today)_/.test(body.name)) app.taskRevision++;
            break;
          case "/api/jobs/save": result = app.jobs.save(body); break;
          case "/api/jobs/acknowledge": result = app.jobs.acknowledge(body); break;
          case "/api/jobs/run": result = app.runJob(body.id); break;
          case "/api/events": result = app.runJob(body.jobId, body.data); break;
          case "/api/import": result = app.jobs.importHub(String(body.path || "D:\\personal-hub")); break;
          case "/api/push": result = app.notifications.subscribe(body); break;
          case "/api/read": {
            const message = app.store.data.messages.find(m => m.id === body.id);
            if (!message) throw new Error("消息不存在");
            message.unread = false; message.readAt = new Date().toISOString(); app.store.save(); result = { read: true }; break;
          }
          case "/api/opentodo/open": {
            const cookie = await app.todo.browserSession();
            res.setHeader("Set-Cookie", `${cookie}; Path=/; HttpOnly; SameSite=Strict`);
            result = { url: app.todo.url }; break;
          }
          default: return json(res, 404, { error: "没有此接口" });
        }
        const readOnlyTool = url.pathname === "/api/tool" && (
          /^opentodo_(list|get|search|today)_/.test(body.name || "") || ["list", "get", "read", "search"].includes(body.args?.action));
        if (!readOnlyTool) changed();
        return json(res, 200, result ?? { ok: true });
      }
      if (url.pathname === "/app.js" && req.method === "GET") {
        res.setHeader("Content-Type", "text/javascript; charset=utf-8"); return res.end(frontend);
      }
      const assets = { "/": ["index.html", "text/html; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"], "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
        "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"], "/icon.svg": ["icon.svg", "image/svg+xml"] };
      const asset = assets[url.pathname];
      if (!asset || req.method !== "GET") return json(res, 404, { error: "页面不存在" });
      if (url.pathname === "/") res.setHeader("Set-Cookie", `cyberboss_desktop=${app.store.data.apiToken}; Path=/; HttpOnly; SameSite=Strict`);
      res.setHeader("Content-Type", asset[1]); res.end(fs.readFileSync(path.join(publicDir, asset[0])));
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error.message }); else res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  try {
    // Only migrate on first use of the new default, after acquiring our port.
    // Restart with Ctrl+C first so the old task database has stopped writing.
    const legacyDir = path.resolve(config.stateDir, "desktop");
    if (!process.env.CYBERBOSS_DESKTOP_DIR && !fs.existsSync(dir) && fs.existsSync(legacyDir) && legacyDir !== dir) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const staging = `${dir}.migrating-${Date.now()}`;
      fs.cpSync(legacyDir, staging, { recursive: true, force: false, errorOnExist: true });
      fs.renameSync(staging, dir);
      console.log(`[cyberboss] 已复制旧工作台数据到 ${dir}；旧目录保留为备份，不再用于运行`);
    }
    app = new DesktopApp(config, dir, changed);
    writeJson(path.join(dir, "endpoint.json"), { url: origin, token: app.store.data.apiToken });
  } catch (error) { server.close(); throw error; }
  console.log(`[cyberboss] 本地工作台 ${origin}`);
  console.log(`[cyberboss] 本机数据目录 ${dir}`);
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    for (const client of clients) client.end();
    await app.close(); server.close(); clearTimeout(notifyTimer);
  };
  process.once("SIGINT", close); process.once("SIGTERM", close);
  try { await app.start(); } catch (error) { await close(); throw error; }
  if (config.argv.includes("--open") && process.platform === "win32") {
    require("child_process").spawn("cmd.exe", ["/c", "start", "", origin], { windowsHide: true, stdio: "ignore" });
  }
  return { app, server, close };
}
function json(res, status, data) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); }
async function readBody(req, limit = 1024 * 1024) {
  if (Number(req.headers["content-length"]) > limit) throw new Error("请求过大");
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
module.exports = { startDesktop };
