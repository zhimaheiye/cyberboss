const { AntigravityProcessClient } = require("./process-client");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const {
  mapAntigravityMessageToRuntimeEvents,
  isSuccessfulResultEvent,
  formatResultFailureReason,
} = require("./events");
const { ensureAntigravityGlobalMcpConfig } = require("./mcp-settings");
const {
  classifyAntigravityFailure,
  hasToolCallEvidence,
} = require("../../../core/ops/error-classifier");
const { IncidentRecorder } = require("../../../core/ops/incident-recorder");
const path = require("path");

function createAntigravityRuntimeAdapter(config = {}) {
  const sessionStore = new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: "antigravity",
  });

  const opsDir = config.opsDir || (config.stateDir ? path.join(config.stateDir, "ops") : undefined);
  const incidentRecorder =
    config.incidentRecorder ||
    new IncidentRecorder({
      opsDir,
      failureThreshold: config.runtimeFailureIncidentThreshold,
      failureWindowMs: config.runtimeFailureWindowMs,
      incidentCooldownMs: config.runtimeIncidentCooldownMs,
    });

  const listeners = new Set();
  const activeRuns = new Map(); // scopeKey -> { client, bindingKey, workspaceRoot, turnId, threadId, cancelled }
  let turnSequence = 0;

  const configuredCommand = config.antigravityCommand || "antigravity";
  const configuredModel = config.antigravityModel || "";
  const configuredEffort = config.antigravityEffort || "";
  const configuredExtraArgs = Array.isArray(config.antigravityExtraArgs) ? config.antigravityExtraArgs : [];
  const configuredTimeoutMs =
    typeof config.antigravityTimeoutMs === "number" && config.antigravityTimeoutMs > 0
      ? config.antigravityTimeoutMs
      : 120_000;

  function emitRuntimeEvent(event, raw) {
    for (const listener of listeners) {
      try {
        listener(event, raw);
      } catch {
        // Prevent listener errors from breaking runtime
      }
    }
  }

  async function runAdapterTurn({
    bindingKey,
    workspaceRoot,
    text,
    metadata = {},
    model = "",
    isInstructionRefresh = false,
  }) {
    const normalizedWorkspace = typeof workspaceRoot === "string" && workspaceRoot.trim() ? workspaceRoot.trim() : process.cwd();
    const scopeKey = `${bindingKey}\0${normalizedWorkspace}`;

    if (activeRuns.has(scopeKey)) {
      throw new Error("antigravity turn already running for this workspace");
    }

    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, normalizedWorkspace) || "";
    const effectiveModel = configuredModel || model || "";

    sessionStore.setRuntimeParamsForWorkspace(bindingKey, normalizedWorkspace, {
      model: effectiveModel,
      modelProvider: "",
    });

    const turnId = `agy-turn-${Date.now()}-${++turnSequence}`;

    try {
      const projectSettings = ensureAntigravityGlobalMcpConfig({
        workspaceRoot: normalizedWorkspace,
        cyberbossHome: process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", ".."),
      });
      console.log(`[antigravity-runtime] workspace=${normalizedWorkspace} mcp_config=${projectSettings.configPath} server=${projectSettings.serverName}`);
    } catch (mcpErr) {
      console.error(`[antigravity-runtime] failed to configure MCP: ${mcpErr.message}`);
    }

    const maxRetries =
      typeof config.antigravityStreamRetryMax === "number" && config.antigravityStreamRetryMax >= 0
        ? config.antigravityStreamRetryMax
        : 1;
    const maxAttempts = 1 + maxRetries;
    const retryDelayMs =
      typeof config.antigravityStreamRetryDelayMs === "number" && config.antigravityStreamRetryDelayMs >= 0
        ? config.antigravityStreamRetryDelayMs
        : 2500;

    let observedConversationId = threadId;
    let terminalRuntimeEventEmitted = false;
    let currentClient = null;
    let currentUnsubscribe = null;
    const recentTurnEvents = [];

    const activeEntry = {
      client: null,
      bindingKey,
      workspaceRoot: normalizedWorkspace,
      turnId,
      threadId: observedConversationId || threadId,
      cancelled: false,
    };
    activeRuns.set(scopeKey, activeEntry);

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (activeEntry.cancelled) {
          throw new Error("antigravity turn was cancelled");
        }

        if (attempt > 1) {
          console.warn(
            `[antigravity-runtime] stream interrupted without tool side effects; retrying turn (attempt ${attempt}/${maxAttempts}) in ${retryDelayMs}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          if (activeEntry.cancelled) {
            throw new Error("antigravity turn was cancelled");
          }
        }

        const currentThreadId =
          observedConversationId ||
          sessionStore.getThreadIdForWorkspace(bindingKey, normalizedWorkspace) ||
          threadId;

        let outboundText = text;
        if (!currentThreadId && !isInstructionRefresh) {
          outboundText = buildOpeningTurnText(config, text);
        }

        currentClient = new AntigravityProcessClient({
          command: configuredCommand,
          cwd: normalizedWorkspace,
          env: process.env,
          extraArgs: configuredExtraArgs,
          timeoutMs: configuredTimeoutMs,
          httpProxy: config.antigravityHttpProxy,
          httpsProxy: config.antigravityHttpsProxy,
          noProxy: config.antigravityNoProxy,
        });
        activeEntry.client = currentClient;

        let hasToolCallsInAttempt = false;

        currentUnsubscribe = currentClient.onMessage((raw) => {
          recentTurnEvents.push(raw);
          if (recentTurnEvents.length > 50) {
            recentTurnEvents.shift();
          }

          if (hasToolCallEvidence(raw)) {
            hasToolCallsInAttempt = true;
          }

          let candidateId = "";
          if (raw.event === "init" && raw.conversation_id) {
            candidateId = raw.conversation_id;
          } else if (raw.event === "result" && raw.result?.conversation_id) {
            candidateId = raw.result.conversation_id;
          }

          if (candidateId) {
            observedConversationId = candidateId;
            sessionStore.setThreadIdForWorkspace(bindingKey, normalizedWorkspace, candidateId, metadata);
            activeEntry.threadId = candidateId;
          }

          const mappedEvents = mapAntigravityMessageToRuntimeEvents(raw, {
            turnId,
            fallbackThreadId: observedConversationId || threadId,
          });

          for (const evt of mappedEvents) {
            if (evt.type === "runtime.turn.completed") {
              terminalRuntimeEventEmitted = true;
              emitRuntimeEvent(evt, raw);
            } else if (evt.type === "runtime.turn.failed") {
              // Defer failure terminal events to catch handler so retryable errors are transparent
              continue;
            } else {
              emitRuntimeEvent(evt, raw);
            }
          }
        });

        try {
          const turnResult = await currentClient.runTurn({
            text: outboundText,
            conversationId: currentThreadId,
            model: effectiveModel,
            effort: configuredEffort,
          });

          if (turnResult.conversationId) {
            sessionStore.setThreadIdForWorkspace(bindingKey, normalizedWorkspace, turnResult.conversationId, metadata);
          }

          const finalThreadId = turnResult.conversationId || observedConversationId || currentThreadId;
          if (!isSuccessfulResultEvent(turnResult, finalThreadId)) {
            const failureMessage = formatResultFailureReason(turnResult);
            throw new Error(failureMessage);
          }

          incidentRecorder.recordSuccess("antigravity", normalizedWorkspace);

          return {
            threadId: turnResult.conversationId || observedConversationId,
            turnId,
          };
        } catch (attemptErr) {
          if (currentUnsubscribe) {
            currentUnsubscribe();
            currentUnsubscribe = null;
          }
          if (currentClient) {
            await currentClient.close().catch(() => {});
            currentClient = null;
            activeEntry.client = null;
          }

          if (activeEntry.cancelled) {
            throw attemptErr;
          }

          const classified = classifyAntigravityFailure(attemptErr);
          const canRetry = attempt < maxAttempts && classified.retryable && !hasToolCallsInAttempt;

          if (canRetry) {
            continue;
          }

          const targetThreadId = observedConversationId || currentThreadId;
          if (targetThreadId && !terminalRuntimeEventEmitted) {
            terminalRuntimeEventEmitted = true;
            emitRuntimeEvent(
              {
                type: "runtime.turn.failed",
                payload: {
                  threadId: targetThreadId,
                  turnId,
                  text: attemptErr instanceof Error ? attemptErr.message : String(attemptErr),
                },
              },
              null
            );
          }

          incidentRecorder.recordFailure({
            runtime: "antigravity",
            workspaceRoot: normalizedWorkspace,
            error: attemptErr,
            turnContext: {
              turnId,
              threadId: targetThreadId,
              attempt,
              maxAttempts,
              model: effectiveModel,
              isInstructionRefresh,
              classification: classified.reason,
              toolActivity: hasToolCallsInAttempt,
              autoRetried: attempt > 1,
            },
            recentEvents: recentTurnEvents,
          });

          throw attemptErr;
        }
      }
    } finally {
      if (currentUnsubscribe) {
        currentUnsubscribe();
      }
      activeRuns.delete(scopeKey);
      if (currentClient) {
        await currentClient.close().catch(() => {});
      }
    }
  }

  return {
    describe() {
      return {
        id: "antigravity",
        kind: "runtime",
        command: configuredCommand,
        sessionsFile: config.sessionsFile,
        model: configuredModel,
        effort: configuredEffort,
      };
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSessionStore() {
      return sessionStore;
    },
    getTurnCapabilities() {
      return {
        nativeImageInput: false,
        toolImageRead: true,
      };
    },
    getIncidentRecorder() {
      return incidentRecorder;
    },
    async initialize() {
      return {
        command: configuredCommand,
        models: [],
      };
    },
    async close() {
      const runs = Array.from(activeRuns.values());
      await Promise.allSettled(runs.map((r) => (r.client ? r.client.close() : Promise.resolve())));
      activeRuns.clear();
      listeners.clear();
    },
    async startFreshThreadDraft() {
      return {};
    },
    async resumeThread({ threadId }) {
      const normalized = typeof threadId === "string" ? threadId.trim() : "";
      if (!normalized) {
        throw new Error("resumeThread requires a non-empty threadId");
      }
      return { threadId: normalized };
    },
    async cancelTurn({ threadId = "", turnId = "", workspaceRoot = "" }) {
      let target = null;
      for (const entry of activeRuns.values()) {
        if (turnId && entry.turnId === turnId) {
          target = entry;
          break;
        }
        if (threadId && entry.threadId === threadId) {
          target = entry;
          break;
        }
        if (workspaceRoot && entry.workspaceRoot === workspaceRoot) {
          target = entry;
          break;
        }
      }
      if (target) {
        target.cancelled = true;
        if (target.client) {
          await target.client.cancel().catch(() => {});
        }
      }
      return { threadId, turnId };
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "" }) {
      const binding = sessionStore.findBindingForThreadId(threadId);
      if (!binding) {
        throw new Error("antigravity thread is not bound to a Cyberboss session");
      }
      const refreshText = buildInstructionRefreshText(config);
      return runAdapterTurn({
        bindingKey: binding.bindingKey,
        workspaceRoot: workspaceRoot || binding.workspaceRoot || process.cwd(),
        text: refreshText,
        metadata: binding.metadata || {},
        model,
        isInstructionRefresh: true,
      });
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({
      bindingKey,
      workspaceRoot,
      text,
      attachments = [],
      metadata = {},
      model = "",
    }) {
      return runAdapterTurn({
        bindingKey,
        workspaceRoot,
        text,
        metadata,
        model,
        isInstructionRefresh: false,
      });
    },
  };
}

module.exports = {
  createAntigravityRuntimeAdapter,
};
