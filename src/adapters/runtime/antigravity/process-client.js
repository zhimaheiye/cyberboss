const { spawn } = require("child_process");
const {
  extractBlockedPersistentTool,
  isSuccessfulResultEvent,
  formatResultFailureReason,
  extractResultError,
  KNOWN_FAILURE_STATUSES,
  normalizeStatus,
} = require("./events");

const FORBIDDEN_EXTRA_ARGS = new Set([
  "-p",
  "--print",
  "--output-format",
  "--conversation",
]);

class AntigravityProcessClient {
  constructor({
    command = "antigravity",
    cwd = process.cwd(),
    env = process.env,
    extraArgs = [],
    timeoutMs = 120_000,
    httpProxy = "",
    httpsProxy = "",
    noProxy = "",
  } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.extraArgs = Array.isArray(extraArgs) ? [...extraArgs] : [];
    this.timeoutMs = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 120_000;
    this.httpProxy = typeof httpProxy === "string" ? httpProxy.trim() : "";
    this.httpsProxy = typeof httpsProxy === "string" ? httpsProxy.trim() : "";
    this.noProxy = typeof noProxy === "string" ? noProxy.trim() : "";
    this.child = null;
    this.running = false;
    this.listeners = new Set();
  }

  buildChildEnv() {
    const childEnv = { ...this.env };
    if (this.httpProxy) {
      childEnv.HTTP_PROXY = this.httpProxy;
      childEnv.http_proxy = this.httpProxy;
    }
    if (this.httpsProxy) {
      childEnv.HTTPS_PROXY = this.httpsProxy;
      childEnv.https_proxy = this.httpsProxy;
    }
    if (this.noProxy) {
      childEnv.NO_PROXY = this.noProxy;
      childEnv.no_proxy = this.noProxy;
    }
    return childEnv;
  }

  onMessage(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(rawEvent) {
    for (const listener of this.listeners) {
      try {
        listener(rawEvent);
      } catch {
        // Prevent listener errors from breaking event processing
      }
    }
  }

  validateExtraArgs(args) {
    for (const arg of args) {
      const normalized = String(arg).trim().toLowerCase();
      if (FORBIDDEN_EXTRA_ARGS.has(normalized) || FORBIDDEN_EXTRA_ARGS.has(normalized.split("=")[0])) {
        throw new Error(`extraArgs contains forbidden protocol argument: ${arg}`);
      }
    }
  }

  async runTurn({
    text,
    conversationId = "",
    model = "",
    effort = "",
  } = {}) {
    if (this.running) {
      throw new Error("antigravity turn already running");
    }
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("text prompt is required for runTurn");
    }

    this.validateExtraArgs(this.extraArgs);

    const args = [
      "--output-format",
      "stream-json",
      "-p",
      text,
    ];

    const requestedConversationId = typeof conversationId === "string" ? conversationId.trim() : "";
    if (requestedConversationId) {
      args.push("--conversation", requestedConversationId);
    }

    const requestedModel = typeof model === "string" ? model.trim() : "";
    if (requestedModel) {
      args.push("--model", requestedModel);
    }

    const requestedEffort = typeof effort === "string" ? effort.trim() : "";
    if (requestedEffort) {
      args.push("--effort", requestedEffort);
    }

    if (this.extraArgs.length > 0) {
      args.push(...this.extraArgs);
    }

    this.running = true;

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutTimer = null;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let reportedConversationId = "";
      let resultEvent = null;

      const cleanup = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        this.child = null;
        this.running = false;
      };

      const safeResolve = (val) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(val);
        }
      };

      const safeReject = (err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };

      const abortAndReject = (err) => {
        if (!settled) {
          settled = true;
          if (this.child && !this.child.killed) {
            try {
              this.child.kill("SIGTERM");
            } catch {
              // ignore
            }
          }
          cleanup();
          reject(err);
        }
      };

      const acceptConversationId = (candidate) => {
        if (!candidate || typeof candidate !== "string") return;
        const trimmed = candidate.trim();
        if (!trimmed) return;

        if (requestedConversationId && trimmed !== requestedConversationId) {
          throw new Error(
            `expected conversation ${requestedConversationId} but antigravity reported ${trimmed}`
          );
        }

        if (reportedConversationId && trimmed !== reportedConversationId) {
          throw new Error(
            `antigravity conversation changed from ${reportedConversationId} to ${trimmed}`
          );
        }

        reportedConversationId = trimmed;
      };

      try {
        const childEnv = this.buildChildEnv();
        this.child = spawn(this.command, args, {
          cwd: this.cwd,
          env: childEnv,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        return abortAndReject(err);
      }

      timeoutTimer = setTimeout(() => {
        abortAndReject(new Error(`antigravity turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString("utf-8");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let parsed;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            const snippet = trimmed.slice(0, 500);
            abortAndReject(new Error(`Failed to parse antigravity stream-json output: "${snippet}"`));
            return;
          }

          if (parsed.event === "init" && parsed.conversation_id) {
            try {
              acceptConversationId(parsed.conversation_id);
            } catch (err) {
              abortAndReject(err);
              return;
            }
          }

          if (parsed.event === "result" && parsed.result) {
            resultEvent = parsed.result;
            if (resultEvent.conversation_id) {
              try {
                acceptConversationId(resultEvent.conversation_id);
              } catch (err) {
                abortAndReject(err);
                return;
              }
            }
          }

          const blockedTool = extractBlockedPersistentTool(parsed);
          if (blockedTool) {
            console.error(`[cyberboss] antigravity blocked unsupported persistent tool: ${blockedTool}`);
            abortAndReject(
              new Error(
                `antigravity attempted unsupported persistent tool: ${blockedTool}. ` +
                `Headless turns cannot run persistent background schedulers or timers. ` +
                `Use Cyberboss persistent reminder/task mechanism instead.`
              )
            );
            return;
          }

          this.emit(parsed);
        }
      });

      this.child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk.toString("utf-8");
      });

      this.child.on("error", (err) => {
        abortAndReject(err);
      });

      this.child.on("close", (code) => {
        if (settled) {
          return;
        }

        if (stdoutBuffer.trim().length > 0) {
          const trimmed = stdoutBuffer.trim();
          stdoutBuffer = "";
          try {
            const parsed = JSON.parse(trimmed);
            const blockedTool = extractBlockedPersistentTool(parsed);
            if (blockedTool) {
              console.error(`[cyberboss] antigravity blocked unsupported persistent tool: ${blockedTool}`);
              return abortAndReject(
                new Error(
                  `antigravity attempted unsupported persistent tool: ${blockedTool}. ` +
                  `Headless turns cannot run persistent background schedulers or timers. ` +
                  `Use Cyberboss persistent reminder/task mechanism instead.`
                )
              );
            }
            if (parsed.event === "result" && parsed.result) {
              resultEvent = parsed.result;
              if (resultEvent.conversation_id) {
                acceptConversationId(resultEvent.conversation_id);
              }
            }
            this.emit(parsed);
          } catch (e) {
            const snippet = trimmed.slice(0, 500);
            return abortAndReject(
              e instanceof Error && e.message.includes("conversation")
                ? e
                : new Error(`Failed to parse trailing antigravity output: "${snippet}"`)
            );
          }
        }

        if (settled) {
          return;
        }

        const finalConversationId = reportedConversationId || resultEvent?.conversation_id || "";
        const hasValidSuccessfulResult = isSuccessfulResultEvent(resultEvent, finalConversationId);

        if (hasValidSuccessfulResult) {
          if (code !== 0) {
            const stderrSummary = summarizeStderr(stderrBuffer);
            console.warn(
              `[cyberboss] antigravity exited nonzero after successful result; accepting completed turn code=${code}${stderrSummary ? ` stderr=${stderrSummary}` : ""}`
            );
          }

          return safeResolve({
            conversationId: finalConversationId,
            response: resultEvent.response ?? "",
            status: resultEvent.status || "SUCCESS",
            numTurns: resultEvent.num_turns ?? 1,
            usage: resultEvent.usage ?? {},
            exitCode: code,
          });
        }

        if (code !== 0 && !resultEvent) {
          if (isAntigravityAuthError(stderrBuffer)) {
            return safeReject(new Error(AUTH_REQUIRED_MESSAGE));
          }
          const errDetail = stderrBuffer.trim() || `exit code ${code}`;
          return safeReject(new Error(`antigravity exited with code ${code}: ${errDetail}`));
        }

        if (!resultEvent) {
          if (isAntigravityAuthError(stderrBuffer)) {
            return safeReject(new Error(AUTH_REQUIRED_MESSAGE));
          }
          const errDetail = stderrBuffer.trim() ? ` (stderr: ${stderrBuffer.trim()})` : "";
          return safeReject(new Error(`antigravity process exited without emitting a result event${errDetail}`));
        }

        const failureMessage = formatResultFailureReason(resultEvent, code);
        if (isAntigravityAuthError(failureMessage) || isAntigravityAuthError(stderrBuffer)) {
          return safeReject(new Error(AUTH_REQUIRED_MESSAGE));
        }

        const hasExplicitError =
          Boolean(extractResultError(resultEvent)) ||
          KNOWN_FAILURE_STATUSES.has(normalizeStatus(resultEvent?.status));
        if (hasExplicitError) {
          return safeReject(new Error(failureMessage));
        }

        if (!finalConversationId) {
          return safeReject(new Error("antigravity process completed but did not provide a conversation ID"));
        }

        return safeReject(new Error(failureMessage));
      });
    });
  }

  async cancel() {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  async close() {
    await this.cancel();
  }
}

const AUTH_REQUIRED_MESSAGE = "AGY authentication required. Please sign in on the desktop.";

function isAntigravityAuthError(text) {
  if (typeof text !== "string") {
    return false;
  }
  return /Authentication required|authentication failed or timed out|not logged into Antigravity/i.test(text);
}

function summarizeStderr(stderr, maxLength = 200) {
  if (typeof stderr !== "string") {
    return "";
  }
  const trimmed = stderr.trim();
  if (!trimmed) {
    return "";
  }
  const sanitized = trimmed
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/https?:\/\/[^\s:@]+:[^\s:@]+@/gi, "http://<redacted>@");
  const singleLine = sanitized.replace(/\r?\n+/g, " | ");
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength)}...`;
}

module.exports = {
  AntigravityProcessClient,
  AUTH_REQUIRED_MESSAGE,
  isAntigravityAuthError,
  isSuccessfulResultEvent,
  summarizeStderr,
};
