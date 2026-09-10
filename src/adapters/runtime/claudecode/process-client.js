const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

class ClaudeCodeProcessClient {
  constructor({ command = "claude", cwd, env, model = "", permissionMode = "default", disableVerbose = false, extraArgs = [], mcpConfigPaths = [], ipcServer = null, workspaceRoot = "" }) {
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.model = model;
    this.permissionMode = permissionMode;
    this.disableVerbose = disableVerbose;
    this.extraArgs = extraArgs;
    this.mcpConfigPaths = mcpConfigPaths;
    this.ipcServer = ipcServer;
    this.workspaceRoot = workspaceRoot;
    this.child = null;
    this.stdin = null;
    this.stdoutBuffer = "";
    this.listeners = new Set();
    this.pendingTurnId = "";
    this.sessionId = "";
    this.resumeSessionId = "";
    this.activeThreadId = "";
    this.alive = false;
    this.sessionWaiters = new Set();
    this.suppressNextCloseEvent = false;
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event, raw) {
    if (this.ipcServer) {
      this.ipcServer.broadcast({ type: "processEvent", event, raw });
    }
    for (const listener of this.listeners) {
      try {
        listener(event, raw);
      } catch {
        // ignore
      }
    }
  }

  async connect(resumeSessionId = "") {
    if (this.child) return;
    this.suppressNextCloseEvent = false;
    this.sessionId = "";
    this.resumeSessionId = isValidSessionId(resumeSessionId) ? resumeSessionId : "";
    this.activeThreadId = "";
    const args = buildArgs({
      model: this.model,
      permissionMode: this.permissionMode,
      disableVerbose: this.disableVerbose,
      extraArgs: this.extraArgs,
      mcpConfigPaths: this.mcpConfigPaths,
      resumeSessionId,
    });
    const mcpLabel = this.mcpConfigPaths.length
      ? this.mcpConfigPaths.join(",")
      : "(none)";
    console.log(
      `[claudecode-runtime] launching command=${this.command} cwd=${this.cwd} mcp_config=${mcpLabel}`
    );

    let spawnTarget;
    try {
      spawnTarget = prepareClaudeSpawn({
        command: this.command,
        args,
        env: this.env,
      });
    } catch (err) {
      this.rejectSessionWaiters(err);
      this.emit({
        type: "process.error",
        error: err.message,
        sessionId: this.activeThreadId || this.sessionId,
        turnId: this.pendingTurnId,
      }, null);
      throw err;
    }

    const { spawnCommand, spawnArgs, spawnOptions } = spawnTarget;

    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        cwd: this.cwd,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
        ...spawnOptions,
      });
    } catch (err) {
      this.rejectSessionWaiters(err);
      this.emit({
        type: "process.error",
        error: err.message,
        sessionId: this.activeThreadId || this.sessionId,
        turnId: this.pendingTurnId,
      }, null);
      throw err;
    }

    this.child = child;
    this.stdin = child.stdin;
    this.alive = true;

    child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        this.handleLine(line.trim());
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.error(`[claudecode-runtime] stderr: ${text}`);
        if (this.ipcServer && !isPotentiallySensitive(text)) {
          this.ipcServer.broadcast({ type: "stderr", text });
        }
      }
    });

    child.on("error", (err) => {
      this.rejectSessionWaiters(err);
      this.alive = false;
      this.child = null;
      this.stdin = null;
      this.emit({ type: "process.error", error: err.message, sessionId: this.activeThreadId || this.sessionId, turnId: this.pendingTurnId }, null);
    });

    child.on("close", (code) => {
      this.rejectSessionWaiters(new Error(`claudecode process closed with code ${code ?? "unknown"}`));
      this.alive = false;
      this.child = null;
      this.stdin = null;
      if (this.suppressNextCloseEvent) {
        this.suppressNextCloseEvent = false;
        return;
      }
      this.emit({ type: "process.close", code, sessionId: this.activeThreadId || this.sessionId, turnId: this.pendingTurnId }, null);
    });
  }

  handleLine(line) {
    if (!line) return;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const eventType = raw?.type;
    switch (eventType) {
      case "system":
        if (raw.session_id) {
          const reportedSessionId = this.acceptReportedSessionId(raw.session_id, raw);
          if (reportedSessionId) {
            this.emit({ type: "session.id", sessionId: reportedSessionId }, raw);
          }
        }
        break;
      case "assistant":
        this.handleAssistant(raw);
        break;
      case "user":
        this.handleUser(raw);
        break;
      case "result":
        this.handleResult(raw);
        break;
      case "control_request":
        this.handleControlRequest(raw);
        break;
      case "control_cancel_request":
        break;
    }
  }

  handleAssistant(raw) {
    const usage = raw?.message?.usage;
    if (usage && typeof usage === "object") {
      this.emit({
        type: "context.updated",
        usage,
        turnId: this.pendingTurnId,
        sessionId: this.activeThreadId || this.sessionId,
      }, raw);
    }
    const content = raw?.message?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const itemType = item.type;
      if (itemType === "text" && typeof item.text === "string" && item.text) {
        this.emit({
          type: "assistant.text",
          text: item.text.trim(),
          turnId: this.pendingTurnId,
          sessionId: this.activeThreadId || this.sessionId,
        }, raw);
      } else if (itemType === "tool_use") {
        const toolName = typeof item.name === "string" ? item.name : "";
        if (toolName === "AskUserQuestion") continue;
        this.emit({
          type: "tool.use",
          toolName,
          input: item.input || {},
          turnId: this.pendingTurnId,
          sessionId: this.activeThreadId || this.sessionId,
        }, raw);
      } else if (itemType === "thinking" && typeof item.thinking === "string" && item.thinking) {
        this.emit({
          type: "thinking",
          text: item.thinking.trim(),
          turnId: this.pendingTurnId,
          sessionId: this.activeThreadId || this.sessionId,
        }, raw);
      }
    }
  }

  handleUser(raw) {
    const content = raw?.message?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "tool_result") {
        const isError = Boolean(item.is_error);
        const resultText = typeof item.content === "string" ? item.content : "";
        this.emit({
          type: "tool.result",
          toolResult: resultText,
          isError,
          turnId: this.pendingTurnId,
          sessionId: this.activeThreadId || this.sessionId,
        }, raw);
      }
    }
  }

  handleResult(raw) {
    if (raw.session_id) {
      const reportedSessionId = this.acceptReportedSessionId(raw.session_id, raw);
      if (!reportedSessionId) {
        return;
      }
    }
    this.emit({
      type: "turn.completed",
      turnId: this.pendingTurnId,
      sessionId: this.activeThreadId || this.sessionId,
      text: typeof raw.result === "string" ? raw.result.trim() : "",
    }, raw);
    this.pendingTurnId = "";
    this.activeThreadId = "";
  }

  acceptReportedSessionId(sessionId, raw) {
    const reportedSessionId = normalizeSessionId(sessionId);
    if (!reportedSessionId) {
      return "";
    }
    const expectedSessionId = normalizeSessionId(this.activeThreadId || this.resumeSessionId);
    if (expectedSessionId && reportedSessionId !== expectedSessionId) {
      this.rejectUnexpectedSessionId(expectedSessionId, reportedSessionId, raw);
      return "";
    }
    if (this.pendingTurnId && !this.activeThreadId) {
      this.activeThreadId = reportedSessionId;
    }
    this.sessionId = reportedSessionId;
    this.resumeSessionId = "";
    this.resolveSessionWaiters(reportedSessionId);
    return reportedSessionId;
  }

  rejectUnexpectedSessionId(expectedSessionId, reportedSessionId, raw) {
    this.suppressNextCloseEvent = true;
    this.emit({
      type: "process.error",
      error: `claudecode resumed unexpected session id: ${reportedSessionId}`,
      sessionId: expectedSessionId,
      turnId: this.pendingTurnId,
    }, raw);
    setImmediate(() => {
      this.close().catch(() => {});
    });
  }

  handleControlRequest(raw) {
    const request = raw?.request || {};
    if (request.subtype !== "can_use_tool") return;
    this.emit({
      type: "approval.requested",
      requestId: raw.request_id,
      toolName: request.tool_name,
      input: request.input,
      sessionId: this.activeThreadId || this.sessionId,
      turnId: this.pendingTurnId,
    }, raw);
  }

  async sendUserMessage({ text, threadId }) {
    if (!this.alive || !this.stdin) {
      throw new Error("claudecode process not running");
    }
    this.pendingTurnId = `turn-${Date.now()}`;
    this.activeThreadId = threadId || this.sessionId;
    if (this.ipcServer) {
      this.ipcServer.broadcast({
        type: "inboundMessage",
        workspaceRoot: this.workspaceRoot,
        text,
      });
    }
    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
    });
    this.stdin.write(payload + "\n");
    this.emit({
      type: "turn.started",
      turnId: this.pendingTurnId,
      sessionId: this.activeThreadId,
    }, null);
  }

  async sendResponse(requestId, { decision }) {
    if (!this.alive || !this.stdin) {
      throw new Error("claudecode process not running");
    }
    const behavior = decision === "accept" ? "allow" : "deny";
    const response = behavior === "allow"
      ? { behavior: "allow", updatedInput: {} }
      : { behavior: "deny", message: "The user denied this tool use. Stop and wait for the user's instructions." };
    const payload = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response,
      },
    });
    this.stdin.write(payload + "\n");
  }

  async waitForSessionId({ timeoutMs = 5000 } = {}) {
    if (this.sessionId) {
      return this.sessionId;
    }
    if (!this.alive) {
      throw new Error("claudecode process not running");
    }
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
    return await new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        this.sessionWaiters.delete(entry);
        reject(new Error("timed out waiting for claudecode session id"));
      }, timeout);
      this.sessionWaiters.add(entry);
    });
  }

  async close() {
    if (!this.child) return;
    if (this.stdin && !this.stdin.destroyed) {
      this.stdin.end();
    }
    if (this.child && !this.child.killed) {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 2000)),
        new Promise((resolve) => this.child.once("close", resolve)),
      ]);
    }
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 3000)),
        new Promise((resolve) => this.child.once("close", resolve)),
      ]);
    }
    if (this.child && !this.child.killed) {
      this.child.kill("SIGKILL");
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 1000)),
        new Promise((resolve) => this.child.once("close", resolve)),
      ]);
    }
    this.alive = false;
    this.child = null;
    this.stdin = null;
    this.sessionId = "";
    this.resumeSessionId = "";
    this.activeThreadId = "";
    this.pendingTurnId = "";
    this.rejectSessionWaiters(new Error("claudecode process closed"));
  }

  resolveSessionWaiters(sessionId) {
    if (!this.sessionWaiters.size) {
      return;
    }
    for (const entry of this.sessionWaiters) {
      clearTimeout(entry.timer);
      entry.resolve(sessionId);
    }
    this.sessionWaiters.clear();
  }

  rejectSessionWaiters(error) {
    if (!this.sessionWaiters.size) {
      return;
    }
    for (const entry of this.sessionWaiters) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.sessionWaiters.clear();
  }
}

function buildArgs({ model, permissionMode, disableVerbose, extraArgs, mcpConfigPaths, resumeSessionId }) {
  const args = [
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--permission-prompt-tool", "stdio",
  ];
  if (!disableVerbose) {
    args.push("--verbose");
  }
  if (permissionMode && permissionMode !== "default") {
    args.push("--permission-mode", permissionMode);
  }
  if (resumeSessionId && isValidSessionId(resumeSessionId)) {
    args.push("--resume", resumeSessionId);
  }
  if (model) {
    args.push("--model", model);
  }
  if (Array.isArray(mcpConfigPaths)) {
    for (const configPath of mcpConfigPaths) {
      if (typeof configPath === "string" && configPath.trim()) {
        args.push("--mcp-config", configPath.trim());
      }
    }
  }
  if (Array.isArray(extraArgs)) {
    const safe = extraArgs.filter((arg) =>
      typeof arg === "string" && arg.length > 0 && !/^-[ce]\b/i.test(arg)
    );
    args.push(...safe);
  }
  return args;
}

function isValidSessionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
}

function normalizeSessionId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

const SENSITIVE_KEYWORDS = /\b(?:key|token|secret|password|credential|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\b/i;
const SENSITIVE_PATTERNS = /\b(?:sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9_\-]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36})\b/i;

function isPotentiallySensitive(text) {
  return SENSITIVE_KEYWORDS.test(text) || SENSITIVE_PATTERNS.test(text);
}

function isBatchScript(filePath) {
  if (typeof filePath !== "string") return false;
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

function isExecutable(filePath) {
  if (typeof filePath !== "string") return false;
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".exe" || ext === ".com";
}

function resolveWindowsCommand(command, env = process.env) {
  const trimmed = typeof command === "string" ? command.trim() : "";
  if (!trimmed) {
    throw new Error("Claude Code command is not specified");
  }

  const rawPathext = (env && typeof env.PATHEXT === "string") ? env.PATHEXT : (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD");
  const pathextList = rawPathext.split(";").map((ext) => ext.trim()).filter(Boolean);

  // If command contains path separators, resolve directly
  if (trimmed.includes("\\") || trimmed.includes("/")) {
    if (fs.existsSync(trimmed)) {
      const resolved = path.resolve(trimmed);
      return {
        resolvedPath: resolved,
        isBatch: isBatchScript(resolved),
        isExe: isExecutable(resolved),
      };
    }

    for (const ext of pathextList) {
      const candidate = `${trimmed}${ext}`;
      if (fs.existsSync(candidate)) {
        const resolved = path.resolve(candidate);
        return {
          resolvedPath: resolved,
          isBatch: isBatchScript(resolved),
          isExe: isExecutable(resolved),
        };
      }
    }

    throw new Error(`Claude Code command not found: ${trimmed}`);
  }

  // Bare command name: search PATH
  const rawPath = (env && typeof env.PATH === "string") ? env.PATH : (process.env.PATH || "");
  const pathDirs = rawPath
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);

  const hasExt = Boolean(path.extname(trimmed));

  for (const dir of pathDirs) {
    if (hasExt) {
      const candidate = path.join(dir, trimmed);
      if (fs.existsSync(candidate)) {
        const resolved = path.resolve(candidate);
        return {
          resolvedPath: resolved,
          isBatch: isBatchScript(resolved),
          isExe: isExecutable(resolved),
        };
      }
    } else {
      for (const ext of pathextList) {
        const candidate = path.join(dir, `${trimmed}${ext}`);
        if (fs.existsSync(candidate)) {
          const resolved = path.resolve(candidate);
          return {
            resolvedPath: resolved,
            isBatch: isBatchScript(resolved),
            isExe: isExecutable(resolved),
          };
        }
      }
      const exactCandidate = path.join(dir, trimmed);
      if (fs.existsSync(exactCandidate)) {
        const resolved = path.resolve(exactCandidate);
        return {
          resolvedPath: resolved,
          isBatch: isBatchScript(resolved),
          isExe: isExecutable(resolved),
        };
      }
    }
  }

  throw new Error(`Claude Code command not found: ${trimmed}`);
}

function resolveClaudeCommand({ command, env = process.env, platform = process.platform } = {}) {
  const trimmed = typeof command === "string" ? command.trim() : "";
  if (!trimmed) {
    throw new Error("Claude Code command is not specified");
  }

  if (platform !== "win32") {
    return {
      resolvedPath: trimmed,
      isBatch: false,
      isExe: false,
    };
  }

  return resolveWindowsCommand(trimmed, env);
}

function quoteCmdArg(arg) {
  const str = String(arg ?? "");
  if (!str) {
    return '""';
  }
  if (!/[\s"]/.test(str)) {
    return str;
  }
  let escaped = str.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\+)$/g, '$1$1');
  return `"${escaped}"`;
}

function prepareClaudeSpawn({ command, args = [], env = process.env, platform = process.platform } = {}) {
  const resolved = resolveClaudeCommand({ command, env, platform });

  if (platform !== "win32" || !resolved.isBatch) {
    return {
      spawnCommand: resolved.resolvedPath,
      spawnArgs: Array.isArray(args) ? [...args] : [],
      spawnOptions: { shell: false },
      resolved,
    };
  }

  const comspec = (env && typeof env.ComSpec === "string" && env.ComSpec.trim())
    || (process.env.ComSpec && process.env.ComSpec.trim())
    || "cmd.exe";

  const safeArgs = Array.isArray(args) ? args : [];
  const innerCommandLine = [quoteCmdArg(resolved.resolvedPath), ...safeArgs.map(quoteCmdArg)].join(" ");
  const fullCommandLine = `"${innerCommandLine}"`;

  return {
    spawnCommand: comspec,
    spawnArgs: ["/d", "/s", "/c", fullCommandLine],
    spawnOptions: {
      windowsVerbatimArguments: true,
      shell: false,
    },
    resolved,
  };
}

module.exports = {
  ClaudeCodeProcessClient,
  resolveClaudeCommand,
  prepareClaudeSpawn,
  quoteCmdArg,
};
