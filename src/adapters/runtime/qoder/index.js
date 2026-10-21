const { QoderProcessClient, SESSION_ID } = require("./process-client");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

function createQoderRuntimeAdapter(config = {}) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "qoder" });
  const listeners = new Set();
  const active = new Map();
  let sequence = 0;
  const command = config.qoderCommand || "qoder";
  const defaultModel = config.qoderModel || "Qwen3.8-Flash";
  const timeoutMs = config.qoderTimeoutMs || 120000;
  const emit = (type, payload) => {
    for (const listener of listeners) {
      try { listener({ type, payload }, null); } catch { /* isolate event listeners */ }
    }
  };
  async function run({ bindingKey, workspaceRoot, text, metadata = {}, model = "", refresh = false }) {
    if (!bindingKey || typeof bindingKey !== "string") throw new Error("Qoder requires a binding key");
    const root = workspaceRoot || process.cwd();
    const scope = `${bindingKey}\0${root}`;
    if (active.has(scope)) throw new Error("Qoder turn already running for this sender and workspace");
    const previousId = sessionStore.getThreadIdForWorkspace(bindingKey, root);
    if (previousId && !SESSION_ID.test(previousId)) throw new Error("Stored Qoder session ID is invalid");
    const chosenModel = model || sessionStore.getRuntimeParamsForWorkspace(bindingKey, root).model || defaultModel;
    const turnId = `qoder-turn-${Date.now()}-${++sequence}`;
    const client = new QoderProcessClient({ command, cwd: root, timeoutMs });
    active.set(scope, { client, bindingKey, turnId, threadId: previousId, workspaceRoot: root });
    const prompt = !previousId && !refresh ? buildOpeningTurnText(config, text) : text;
    try {
      const result = await client.runTurn({ text: prompt, sessionId: previousId, model: chosenModel });
      sessionStore.setThreadIdForWorkspace(bindingKey, root, result.sessionId, metadata);
      sessionStore.setRuntimeParamsForWorkspace(bindingKey, root, { model: chosenModel });
      emit("runtime.turn.started", { threadId: result.sessionId, turnId });
      if (result.usage && (result.usage.input_tokens || result.usage.output_tokens)) {
        emit("runtime.context.updated", {
          runtimeId: "qoder", threadId: result.sessionId, turnId,
          inputTokens: Number(result.usage.input_tokens) || 0,
          outputTokens: Number(result.usage.output_tokens) || 0,
        });
      }
      emit("runtime.reply.completed", { threadId: result.sessionId, turnId, itemId: `qoder-result-${turnId}`, text: result.text });
      emit("runtime.turn.completed", { threadId: result.sessionId, turnId, text: result.text });
      return { threadId: result.sessionId, turnId };
    } catch (error) {
      if (previousId) emit("runtime.turn.failed", { threadId: previousId, turnId, text: error.message });
      throw error;
    } finally {
      active.delete(scope);
      await client.close();
    }
  }
  return {
    describe: () => ({ id: "qoder", kind: "runtime", command, model: defaultModel, sessionsFile: config.sessionsFile }),
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSessionStore: () => sessionStore,
    getTurnCapabilities: () => ({ nativeImageInput: false, toolImageRead: false }),
    async initialize() {
      try {
        const { stdout } = await execFileAsync(command, ["--list-models"], {
          timeout: 20000, maxBuffer: 32 * 1024,
        });
        const models = stdout.split(/\r?\n/).map((model) => model.trim())
          .filter((model) => /^[a-zA-Z0-9._-]{1,80}$/.test(model) && model !== "MODEL")
          .map((model) => ({ model }));
        if (models.length) sessionStore.setAvailableModelCatalog(models);
        return { command, models };
      } catch {
        return { command, models: [] };
      }
    },
    async close() { await Promise.allSettled([...active.values()].map((entry) => entry.client.close())); active.clear(); listeners.clear(); },
    async startFreshThreadDraft({ bindingKey, workspaceRoot }) {
      if (active.has(`${bindingKey}\0${workspaceRoot}`)) throw new Error("Cannot start a new Qoder thread during an active turn");
      return {};
    },
    getActiveTurnForScope({ bindingKey, workspaceRoot }) {
      const entry = active.get(`${bindingKey}\0${workspaceRoot}`);
      return entry ? { turnId: entry.turnId, threadId: entry.threadId } : null;
    },
    async resumeThread({ threadId }) { if (!SESSION_ID.test(threadId || "")) throw new Error("Invalid Qoder session ID"); return { threadId }; },
    async cancelTurn({ bindingKey = "", threadId = "", turnId = "", workspaceRoot = "" } = {}) {
      for (const entry of active.values()) {
        if (bindingKey && entry.bindingKey !== bindingKey) continue;
        if ((turnId && entry.turnId === turnId) || (threadId && entry.threadId === threadId) ||
            (workspaceRoot && entry.workspaceRoot === workspaceRoot)) await entry.client.cancel();
      }
      return { threadId, turnId };
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "" }) {
      const binding = sessionStore.findBindingForThreadId(threadId);
      if (!binding) throw new Error("Qoder thread is not bound to a CyberBoss session");
      return run({ bindingKey: binding.bindingKey, workspaceRoot: workspaceRoot || binding.workspaceRoot,
        text: buildInstructionRefreshText(config), metadata: binding.metadata || {}, model, refresh: true });
    },
    async sendTextTurn(args) { return run(args); },
    async sendTurn(args) { return run(args); },
  };
}

module.exports = { createQoderRuntimeAdapter };
