const { spawn } = require("child_process");

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class QoderProcessClient {
  constructor({ command = "qoder", cwd = process.cwd(), env = process.env, timeoutMs = 120000 } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.running = false;
  }

  async runTurn({ text, sessionId = "", model = "" } = {}) {
    if (this.running) throw new Error("Qoder turn already running");
    if (typeof text !== "string" || !text.trim()) throw new Error("Qoder prompt is empty");
    if (sessionId && !SESSION_ID.test(sessionId)) throw new Error("Invalid Qoder session ID");
    if (model && !/^[a-zA-Z0-9._-]{1,80}$/.test(model)) throw new Error("Invalid Qoder model ID");
    const args = ["--print", "--output-format", "stream-json", "--input-format", "text",
      "--tools", "", "--strict-mcp-config", "--setting-sources", "user",
      "--permission-mode", "dont_ask",
      "--max-turns", "1", "--max-output-tokens", "2048", "--max-model-request-retries", "0"];
    if (model) args.push("--model", model);
    if (sessionId) args.push("--resume", sessionId);
    this.running = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      let bytes = 0;
      let buffer = "";
      let reportedId = "";
      let final = null;
      let stderr = "";
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) this.terminate();
        this.child = null;
        this.running = false;
        if (error) reject(error); else resolve(value);
      };
      const readLine = (line) => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch { throw new Error("Malformed Qoder JSONL output"); }
        if (!event || typeof event !== "object") throw new Error("Invalid Qoder event");
        if (typeof event.session_id === "string" && SESSION_ID.test(event.session_id)) {
          if (sessionId && event.session_id !== sessionId) throw new Error("Qoder resumed a different session");
          if (reportedId && event.session_id !== reportedId) throw new Error("Qoder session changed during turn");
          reportedId = event.session_id;
        }
        if (event.type === "result") {
          if (final) throw new Error("Duplicate Qoder final result");
          final = event;
        }
      };
      const timer = setTimeout(() => finish(new Error("Qoder turn timed out")), this.timeoutMs);
      try {
        this.child = spawn(this.command, args, {
          cwd: this.cwd, env: this.env,
          // Windows Qoder installations commonly expose a .cmd launcher. All arguments
          // here are fixed flags, a validated model, or a UUID; the prompt stays on stdin.
          shell: process.platform === "win32", detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) { finish(error); return; }
      this.child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) { finish(new Error("Qoder output exceeded limit")); return; }
        buffer += chunk.toString("utf8");
        let newline;
        try {
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); readLine(line);
          }
        } catch (error) { finish(error); }
      });
      this.child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2048); });
      this.child.on("error", (error) => finish(error));
      this.child.on("close", (code, signal) => {
        if (settled) return;
        try { readLine(buffer); } catch (error) { finish(error); return; }
        if (code !== 0 || signal) {
          // stderr can contain account details or user text, so never include it in the error.
          finish(new Error(`Qoder exited unsuccessfully (code ${code ?? "signal"})`)); return;
        }
        if (!final || final.subtype !== "success" || final.is_error ||
            typeof final.result !== "string" || !final.result.trim() || !reportedId) {
          finish(new Error("Qoder did not return a successful nonempty final reply")); return;
        }
        finish(null, { sessionId: reportedId, text: final.result.trim(), usage: final.usage });
      });
      this.child.stdin.on("error", () => {});
      this.child.stdin.end(text);
    });
  }

  terminate() {
    if (!this.child || this.child.killed) return;
    if (process.platform !== "win32" && this.child.pid) {
      try { process.kill(-this.child.pid, "SIGKILL"); return; } catch { /* fall back */ }
    }
    this.child.kill("SIGKILL");
  }
  async cancel() { this.terminate(); }
  async close() { await this.cancel(); }
}

module.exports = { QoderProcessClient, SESSION_ID };
