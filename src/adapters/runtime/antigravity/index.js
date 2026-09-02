const { AntigravityProcessClient } = require("./process-client");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { mapAntigravityMessageToRuntimeEvents } = require("./events");

function createAntigravityRuntimeAdapter(config = {}) {
  const sessionStore = new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: "antigravity",
  });

  const listeners = new Set();
  const activeRuns = new Map(); // scopeKey -> { client, bindingKey, workspaceRoot, turnId, threadId }
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

    let outboundText = text;
    if (!threadId && !isInstructionRefresh) {
      outboundText = buildOpeningTurnText(config, text);
    }

    const client = new AntigravityProcessClient({
      command: configuredCommand,
      cwd: normalizedWorkspace,
      env: process.env,
      extraArgs: configuredExtraArgs,
      timeoutMs: configuredTimeoutMs,
    });

    let observedConversationId = threadId;
    let terminalRuntimeEventEmitted = false;

    activeRuns.set(scopeKey, {
      client,
      bindingKey,
      workspaceRoot: normalizedWorkspace,
      turnId,
      threadId,
    });

    const unsubscribeRaw = client.onMessage((raw) => {
      // Capture conversation ID from init or result
      let candidateId = "";
      if (raw.event === "init" && raw.conversation_id) {
        candidateId = raw.conversation_id;
      } else if (raw.event === "result" && raw.result?.conversation_id) {
        candidateId = raw.result.conversation_id;
      }

      if (candidateId) {
        observedConversationId = candidateId;
        // IMPORTANT: Write to SessionStore BEFORE emitting runtime events so binding lookup succeeds
        sessionStore.setThreadIdForWorkspace(bindingKey, normalizedWorkspace, candidateId, metadata);
        const activeEntry = activeRuns.get(scopeKey);
        if (activeEntry) {
          activeEntry.threadId = candidateId;
        }
      }

      // Map and emit runtime events
      const mappedEvents = mapAntigravityMessageToRuntimeEvents(raw, {
        turnId,
        fallbackThreadId: observedConversationId || threadId,
      });

      for (const evt of mappedEvents) {
        if (evt.type === "runtime.turn.completed" || evt.type === "runtime.turn.failed") {
          terminalRuntimeEventEmitted = true;
        }
        emitRuntimeEvent(evt, raw);
      }
    });

    try {
      const turnResult = await client.runTurn({
        text: outboundText,
        conversationId: threadId,
        model: effectiveModel,
        effort: configuredEffort,
      });

      if (turnResult.conversationId) {
        sessionStore.setThreadIdForWorkspace(bindingKey, normalizedWorkspace, turnResult.conversationId, metadata);
      }

      if (turnResult.status !== "SUCCESS") {
        if (!terminalRuntimeEventEmitted) {
          terminalRuntimeEventEmitted = true;
          emitRuntimeEvent(
            {
              type: "runtime.turn.failed",
              payload: {
                threadId: turnResult.conversationId || observedConversationId || threadId,
                turnId,
                text: turnResult.response || `Antigravity turn failed with status ${turnResult.status}`,
              },
            },
            null
          );
        }
        throw new Error(`Antigravity turn failed with status ${turnResult.status}: ${turnResult.response || ""}`);
      }

      return {
        threadId: turnResult.conversationId || observedConversationId,
        turnId,
      };
    } catch (err) {
      const targetThreadId = observedConversationId || threadId;
      if (targetThreadId && !terminalRuntimeEventEmitted) {
        terminalRuntimeEventEmitted = true;
        emitRuntimeEvent(
          {
            type: "runtime.turn.failed",
            payload: {
              threadId: targetThreadId,
              turnId,
              text: err instanceof Error ? err.message : String(err),
            },
          },
          null
        );
      }
      throw err;
    } finally {
      unsubscribeRaw();
      activeRuns.delete(scopeKey);
      await client.close().catch(() => {});
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
    async initialize() {
      return {
        command: configuredCommand,
        models: [],
      };
    },
    async close() {
      const runs = Array.from(activeRuns.values());
      await Promise.allSettled(runs.map((r) => r.client.close()));
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
        await target.client.cancel().catch(() => {});
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
