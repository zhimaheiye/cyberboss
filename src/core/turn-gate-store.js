class TurnGateStore {
  constructor() {
    this.scopeByThreadId = new Map();
    this.pendingScopeKeys = new Set();
  }

  begin(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return "";
    }
    this.pendingScopeKeys.add(scopeKey);
    return scopeKey;
  }

  attachThread(scopeKey, threadId) {
    const normalizedScopeKey = normalizeText(scopeKey);
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedScopeKey || !normalizedThreadId) {
      return;
    }
    // Only record the mapping when the scope is still pending.
    // If a terminal runtime event fired before sendTurn() resolved (AGY timing
    // race), the scope was already released via releaseScope(). Writing the
    // mapping here would leave a stale entry that could block future turns.
    if (!this.pendingScopeKeys.has(normalizedScopeKey)) {
      return;
    }
    this.scopeByThreadId.set(normalizedThreadId, normalizedScopeKey);
  }

  releaseScope(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return;
    }
    this.pendingScopeKeys.delete(scopeKey);
  }

  releaseThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const scopeKey = this.scopeByThreadId.get(normalizedThreadId) || "";
    if (scopeKey) {
      this.pendingScopeKeys.delete(scopeKey);
      this.scopeByThreadId.delete(normalizedThreadId);
    }
  }

  isPending(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    return scopeKey ? this.pendingScopeKeys.has(scopeKey) : false;
  }
}

function buildTurnScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { TurnGateStore };
