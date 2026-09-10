const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { EventEmitter } = require("events");

function isNamedPipeEndpoint(endpoint) {
  if (typeof endpoint !== "string") {
    return false;
  }
  return endpoint.startsWith("\\\\.\\pipe\\") || endpoint.startsWith("//./pipe/");
}

function normalizeCanonicalStateDir(stateDir) {
  const dir = typeof stateDir === "string" && stateDir.trim()
    ? stateDir.trim()
    : path.join(os.homedir(), ".cyberboss");
  let resolved = path.resolve(dir);
  if (resolved.length > 3 && (resolved.endsWith("\\") || resolved.endsWith("/"))) {
    resolved = resolved.slice(0, -1);
  }
  return resolved.toLowerCase();
}

function resolveClaudeIpcEndpoint(stateDir, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const normalizedStateDir = typeof stateDir === "string" && stateDir.trim()
    ? stateDir.trim()
    : p.join(os.homedir(), ".cyberboss");

  if (platform === "win32") {
    const canonical = normalizeCanonicalStateDir(normalizedStateDir);
    const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
    return `\\\\.\\pipe\\cyberboss-claudecode-runtime-${hash}`;
  }

  return path.posix.join(normalizedStateDir.replace(/\\/g, "/"), "claudecode-runtime.sock");
}

function resolveClaudeIpcTokenPath(stateDir, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const normalizedStateDir = typeof stateDir === "string" && stateDir.trim()
    ? stateDir.trim()
    : p.join(os.homedir(), ".cyberboss");

  return p.join(normalizedStateDir, "claudecode-runtime.token");
}

class ClaudeCodeIpcServer extends EventEmitter {
  constructor({
    endpoint,
    socketPath = endpoint,
    tokenFile,
    stateDir,
    platform = process.platform,
  } = {}) {
    super();
    this.platform = platform;
    const resolvedEndpoint = endpoint || socketPath || resolveClaudeIpcEndpoint(stateDir, platform);
    this.endpoint = resolvedEndpoint;
    this.socketPath = resolvedEndpoint;
    this.isNamedPipe = isNamedPipeEndpoint(this.endpoint);
    this.stateDir = stateDir || (this.isNamedPipe ? path.join(os.homedir(), ".cyberboss") : path.dirname(this.socketPath));
    this.tokenFile = tokenFile || resolveClaudeIpcTokenPath(this.stateDir, this.platform);
    this.authToken = "";
    this.server = null;
    this.clients = new Set();
    this.authenticated = new Set();
  }

  async start() {
    if (this.server) return;
    this.ensureDirectory();
    this.removeStaleSocket();
    this.generateAuthToken();

    const server = net.createServer((socket) => {
      this.clients.add(socket);
      socket.setEncoding("utf8");

      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (!this.authenticated.has(socket)) {
              if (msg?.type === "auth" && msg?.token === this.authToken) {
                this.authenticated.add(socket);
              }
              continue;
            }
            if (validateIpcMessage(msg)) {
              this.emit("clientMessage", msg, socket);
            }
          } catch {
            // ignore malformed
          }
        }
      });

      socket.on("close", () => {
        this.clients.delete(socket);
        this.authenticated.delete(socket);
      });

      socket.on("error", () => {
        this.clients.delete(socket);
        this.authenticated.delete(socket);
      });
    });

    this.server = server;

    await new Promise((resolve, reject) => {
      let settled = false;

      const onError = (err) => {
        if (settled) return;
        settled = true;
        server.removeListener("listening", onListening);
        this.removeAuthToken();
        if (this.server === server) {
          try {
            server.close(() => {});
          } catch {
            // ignore
          }
          this.server = null;
        }
        reject(err);
      };

      const onListening = () => {
        if (settled) return;
        settled = true;
        server.removeListener("error", onError);
        server.on("error", (err) => {
          this.emit("error", err);
        });
        if (!this.isNamedPipe) {
          try {
            fs.chmodSync(this.socketPath, 0o600);
          } catch {
            // ignore
          }
        }
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });
  }

  broadcast(event) {
    const payload = JSON.stringify(event) + "\n";
    for (const client of this.authenticated) {
      try {
        client.write(payload);
      } catch {
        // ignore dead sockets
      }
    }
  }

  ensureDirectory() {
    if (this.isNamedPipe) {
      return;
    }
    const dir = path.dirname(this.socketPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  removeStaleSocket() {
    if (this.isNamedPipe) {
      return;
    }
    try {
      const stat = fs.lstatSync(this.socketPath);
      if (!stat.isSocket()) {
        return;
      }
      fs.unlinkSync(this.socketPath);
    } catch {
      // ignore
    }
  }

  generateAuthToken() {
    this.authToken = crypto.randomBytes(32).toString("hex");
    try {
      const dir = path.dirname(this.tokenFile);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.tokenFile, this.authToken, { mode: 0o600 });
    } catch {
      // ignore
    }
  }

  removeAuthToken() {
    try {
      fs.unlinkSync(this.tokenFile);
    } catch {
      // ignore
    }
  }

  async close() {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.authenticated.clear();

    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise((resolve) => {
        s.close(resolve);
      });
    }

    if (!this.isNamedPipe) {
      this.removeStaleSocket();
    }
    this.removeAuthToken();
  }
}

function validateIpcMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return false;
  }
  const type = msg.type;
  if (typeof type !== "string") {
    return false;
  }
  switch (type) {
    case "sendUserMessage":
      return typeof msg.workspaceRoot === "string" && typeof msg.text === "string";
    case "respondApproval":
      return typeof msg.workspaceRoot === "string" && typeof msg.requestId === "string";
    default:
      return true;
  }
}

module.exports = {
  ClaudeCodeIpcServer,
  resolveClaudeIpcEndpoint,
  resolveClaudeIpcTokenPath,
  isNamedPipeEndpoint,
  validateIpcMessage,
};
