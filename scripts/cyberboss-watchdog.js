const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const { IncidentRecorder } = require("../src/core/ops/incident-recorder");
const { sanitizeText } = require("../src/core/ops/sanitize");
const { readConfig } = require("../src/core/config");

const DEFAULT_RESTART_DELAY_MS = 5000;
const DEFAULT_MAX_CRASHES = 3;
const DEFAULT_CRASH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RING_BUFFER_SIZE = 200;

class CyberbossWatchdog {
  constructor(options = {}) {
    this.targetScript = options.targetScript || path.join(__dirname, "shared-start.js");
    this.targetArgs = options.targetArgs || process.argv.slice(2);
    this.restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    this.maxCrashes = options.maxCrashes ?? DEFAULT_MAX_CRASHES;
    this.crashWindowMs = options.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS;
    this.ringBufferSize = options.ringBufferSize ?? RING_BUFFER_SIZE;
    this.cwd = options.cwd || path.resolve(__dirname, "..");
    this.env = options.env || process.env;

    const config = readConfig();
    this.incidentRecorder =
      options.incidentRecorder ||
      new IncidentRecorder({
        opsDir: config.opsDir,
        failureThreshold: this.maxCrashes,
        failureWindowMs: this.crashWindowMs,
      });

    this.ringBuffer = [];
    this.crashHistory = [];
    this.child = null;
    this.intentionalShutdown = false;
    this.running = false;
    this._resolveStopped = null;
    this._stopPromise = null;
    this._onSigInt = null;
    this._onSigTerm = null;
  }

  appendLog(line) {
    if (typeof line !== "string") return;
    const sanitized = sanitizeText(line);
    this.ringBuffer.push(sanitized);
    if (this.ringBuffer.length > this.ringBufferSize) {
      this.ringBuffer.shift();
    }
  }

  recordCrash() {
    const now = Date.now();
    this.crashHistory.push(now);
    const windowStart = now - this.crashWindowMs;
    this.crashHistory = this.crashHistory.filter((t) => t >= windowStart);
    return this.crashHistory.length;
  }

  async start() {
    if (this.running) return this._stopPromise;
    this.running = true;
    this.intentionalShutdown = false;

    this._stopPromise = new Promise((resolve) => {
      this._resolveStopped = resolve;
    });

    this._setupSignalHandlers();
    this._runLoop();

    return this._stopPromise;
  }

  async stop(signal = "SIGTERM") {
    if (!this.running && !this.child) return;
    this.intentionalShutdown = true;
    this.running = false;
    if (this.child && !this.child.killed) {
      try {
        this.child.kill(signal);
      } catch {
        // ignore
      }
    }
    if (this._resolveStopped) {
      this._resolveStopped({ intentional: true, code: 0 });
    }
  }

  _setupSignalHandlers() {
    this._onSigInt = () => {
      console.log("\n[cyberboss-watchdog] received SIGINT, stopping cleanly...");
      this.stop("SIGINT");
    };
    this._onSigTerm = () => {
      console.log("\n[cyberboss-watchdog] received SIGTERM, stopping cleanly...");
      this.stop("SIGTERM");
    };

    process.on("SIGINT", this._onSigInt);
    process.on("SIGTERM", this._onSigTerm);
  }

  _removeSignalHandlers() {
    if (this._onSigInt) process.removeListener("SIGINT", this._onSigInt);
    if (this._onSigTerm) process.removeListener("SIGTERM", this._onSigTerm);
  }

  async _runLoop() {
    while (this.running && !this.intentionalShutdown) {
      const exitResult = await this._spawnChild();

      if (this.intentionalShutdown) {
        break;
      }

      if (exitResult.code === 0) {
        console.log("[cyberboss-watchdog] child process exited cleanly with code 0.");
        this.running = false;
        if (this._resolveStopped) {
          this._resolveStopped(exitResult);
        }
        break;
      }

      // Unexpected crash
      console.warn(
        `[cyberboss-watchdog] child process exited unexpectedly (code: ${exitResult.code}, signal: ${exitResult.signal})`
      );
      const recentCrashCount = this.recordCrash();

      if (recentCrashCount >= this.maxCrashes) {
        console.error(
          `[cyberboss-watchdog] crash loop threshold reached (${recentCrashCount} crashes in ${Math.round(
            this.crashWindowMs / 60000
          )}m). Halting watchdog.`
        );

        this.incidentRecorder.recordCrashLoopIncident({
          runtimeId: this.env.CYBERBOSS_RUNTIME || "antigravity",
          workspaceRoot: this.cwd,
          crashCount: recentCrashCount,
          recentLogs: this.ringBuffer,
        });

        this.running = false;
        if (this._resolveStopped) {
          this._resolveStopped({ ...exitResult, crashLoop: true });
        }
        break;
      }

      console.log(
        `[cyberboss-watchdog] restarting child in ${this.restartDelayMs}ms... (${recentCrashCount}/${this.maxCrashes} crashes in window)`
      );
      await new Promise((resolve) => setTimeout(resolve, this.restartDelayMs));
    }

    this._removeSignalHandlers();
  }

  _spawnChild() {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [this.targetScript, ...this.targetArgs], {
        cwd: this.cwd,
        env: this.env,
        stdio: ["inherit", "pipe", "pipe"],
      });

      this.child = child;

      const rlOut = readline.createInterface({ input: child.stdout });
      rlOut.on("line", (line) => {
        process.stdout.write(line + "\n");
        this.appendLog(`[stdout] ${line}`);
      });

      const rlErr = readline.createInterface({ input: child.stderr });
      rlErr.on("line", (line) => {
        process.stderr.write(line + "\n");
        this.appendLog(`[stderr] ${line}`);
      });

      child.on("close", (code, signal) => {
        this.child = null;
        resolve({ code, signal });
      });

      child.on("error", (err) => {
        this.appendLog(`[error] spawn failed: ${err.message}`);
        console.error(`[cyberboss-watchdog] child spawn error: ${err.message}`);
        this.child = null;
        resolve({ code: 1, signal: null, error: err });
      });
    });
  }
}

if (require.main === module) {
  const watchdog = new CyberbossWatchdog();
  watchdog.start().then((result) => {
    process.exit(result && result.code !== undefined ? result.code : 0);
  });
}

module.exports = {
  CyberbossWatchdog,
  DEFAULT_RESTART_DELAY_MS,
  DEFAULT_MAX_CRASHES,
  DEFAULT_CRASH_WINDOW_MS,
  RING_BUFFER_SIZE,
};
