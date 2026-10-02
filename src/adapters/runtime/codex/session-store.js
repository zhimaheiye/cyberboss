const fs = require("fs");
const path = require("path");
const { normalizeModelCatalog } = require("./model-catalog");
const { normalizeCommandTokens } = require("../shared/approval-command");

class SessionStore {
  constructor({ filePath, runtimeId = "" }) {
    this.filePath = filePath;
    this.runtimeId = normalizeValue(runtimeId);
    this.state = createEmptyState();
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        this.state = migrateSessionStoreState(parsed, process.platform);
        const serialized = JSON.stringify(this.state, null, 2);
        if (serialized !== raw.trim()) {
          this.save();
        }
      }
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getBinding(bindingKey) {
    return this.state.bindings[bindingKey] || null;
  }

  listBindings() {
    return Object.entries(this.state.bindings || {}).map(([bindingKey, binding]) => ({
      bindingKey,
      ...(binding || {}),
    }));
  }

  getActiveWorkspaceRoot(bindingKey) {
    return normalizeWorkspacePath(this.state.bindings[bindingKey]?.activeWorkspaceRoot);
  }

  updateBinding(bindingKey, nextBinding) {
    this.state.bindings[bindingKey] = {
      ...(this.state.bindings[bindingKey] || {}),
      ...(nextBinding || {}),
    };
    this.save();
    return this.state.bindings[bindingKey];
  }

  getThreadIdForWorkspace(bindingKey, workspaceRoot, runtimeId = this.runtimeId) {
    const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return "";
    }
    const binding = this.getBinding(bindingKey) || {};
    const scoped = getThreadMapForRuntime(binding, runtimeId);
    if (scoped[normalizedWorkspaceRoot]) {
      return scoped[normalizedWorkspaceRoot];
    }
    return "";
  }

  setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, extra = {}, runtimeId = this.runtimeId) {
    const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const normalizedRuntimeId = normalizeValue(runtimeId);
    const normalizedThreadId = normalizeThreadValue(threadId);
    const threadIdByWorkspaceRootByRuntime = {
      ...getThreadRuntimeMap(current),
      [normalizedRuntimeId || "default"]: {
        ...getThreadMapForRuntime(current, normalizedRuntimeId),
        [normalizedWorkspaceRoot]: normalizedThreadId,
      },
    };
    const nextBinding = {
      ...current,
      ...extra,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadIdByWorkspaceRootByRuntime,
    };

    if (normalizedRuntimeId === "codex") {
      nextBinding.threadIdByWorkspaceRoot = {
        ...getLegacyThreadMap(current),
        [normalizedWorkspaceRoot]: normalizedThreadId,
      };
    }

    return this.updateBinding(bindingKey, nextBinding);
  }

  getRuntimeParamsForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return { model: "", modelProvider: "" };
    }
    const current = this.getBinding(bindingKey) || {};
    const runtimeId = normalizeValue(this.runtimeId);
    const entry = getRuntimeParamsMapForRuntime(current, runtimeId)[normalizedWorkspaceRoot]
      || (runtimeId === "codex" ? getCodexParamsMap(current)[normalizedWorkspaceRoot] : null);
    return {
      model: normalizeValue(entry?.model),
      modelProvider: normalizeValue(entry?.modelProvider || entry?.model_provider),
    };
  }

  setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, params = {}) {
    const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }
    const current = this.getBinding(bindingKey) || {};
    const runtimeId = normalizeValue(this.runtimeId) || "default";
    const previousEntry = getRuntimeParamsMapForRuntime(current, runtimeId)[normalizedWorkspaceRoot]
      || (runtimeId === "codex" ? getCodexParamsMap(current)[normalizedWorkspaceRoot] : {})
      || {};
    const hasModel = Object.prototype.hasOwnProperty.call(params, "model");
    const hasModelProvider = Object.prototype.hasOwnProperty.call(params, "modelProvider");
    const nextEntry = {
      ...previousEntry,
      model: hasModel ? normalizeValue(params.model) : normalizeValue(previousEntry.model),
      modelProvider: hasModelProvider
        ? normalizeValue(params.modelProvider)
        : normalizeValue(previousEntry.modelProvider || previousEntry.model_provider),
    };
    const runtimeParamsByWorkspaceRootByRuntime = {
      ...getRuntimeParamsRuntimeMap(current),
      [runtimeId]: {
        ...getRuntimeParamsMapForRuntime(current, runtimeId),
        [normalizedWorkspaceRoot]: nextEntry,
      },
    };
    const nextBinding = {
      ...current,
      runtimeParamsByWorkspaceRootByRuntime,
    };
    if (runtimeId === "codex") {
      nextBinding.codexParamsByWorkspaceRoot = {
        ...getCodexParamsMap(current),
        [normalizedWorkspaceRoot]: {
          ...previousEntry,
          ...nextEntry,
        },
      };
    }
    return this.updateBinding(bindingKey, nextBinding);
  }

  clearThreadIdForWorkspace(bindingKey, workspaceRoot, runtimeId = this.runtimeId) {
    const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }
    const current = this.getBinding(bindingKey) || {};
    const normalizedRuntimeId = normalizeValue(runtimeId);
    const threadIdByWorkspaceRootByRuntime = {
      ...getThreadRuntimeMap(current),
      [normalizedRuntimeId || "default"]: {
        ...getThreadMapForRuntime(current, normalizedRuntimeId),
        [normalizedWorkspaceRoot]: "",
      },
    };
    const nextBinding = {
      ...current,
      threadIdByWorkspaceRootByRuntime,
    };
    if (normalizedRuntimeId === "codex") {
      nextBinding.threadIdByWorkspaceRoot = {
        ...getLegacyThreadMap(current),
        [normalizedWorkspaceRoot]: "",
      };
    }
    return this.updateBinding(bindingKey, nextBinding);
  }

  setActiveWorkspaceRoot(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }
    return this.updateBinding(bindingKey, {
      activeWorkspaceRoot: normalizedWorkspaceRoot,
    });
  }

  listWorkspaceRoots(bindingKey, runtimeId = this.runtimeId) {
    const current = this.getBinding(bindingKey) || {};
    return Object.keys(getThreadMapForRuntime(current, runtimeId)).map((p) => normalizeWorkspacePath(p));
  }

  findBindingForThreadId(threadId, runtimeId = this.runtimeId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const normalizedRuntimeId = normalizeValue(runtimeId);
    for (const [bindingKey, binding] of Object.entries(this.state.bindings || {})) {
      for (const [workspaceRoot, candidateThreadId] of Object.entries(getThreadMapForRuntime(binding, normalizedRuntimeId))) {
        if (normalizeValue(candidateThreadId) === normalizedThreadId) {
          return {
            bindingKey,
            workspaceRoot: normalizeWorkspacePath(workspaceRoot),
          };
        }
      }
    }
    return null;
  }

  getApprovalCommandAllowlistForWorkspace(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return [];
    }
    const raw = this.state.approvalCommandAllowlistByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .filter((entry) => Array.isArray(entry))
      .map((entry) => entry.map((part) => normalizeValue(part)).filter(Boolean))
      .filter((entry) => entry.length);
  }

  rememberApprovalPrefixForWorkspace(workspaceRoot, commandTokens) {
    const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
    const normalizedTokens = normalizeCommandTokens(commandTokens);
    if (!normalizedWorkspaceRoot || !normalizedTokens.length) {
      return this.getApprovalCommandAllowlistForWorkspace(workspaceRoot);
    }
    const current = this.getApprovalCommandAllowlistForWorkspace(normalizedWorkspaceRoot);
    if (!current.some((entry) => isSameTokenList(entry, normalizedTokens))) {
      current.push(normalizedTokens);
      this.state.approvalCommandAllowlistByWorkspaceRoot = {
        ...(this.state.approvalCommandAllowlistByWorkspaceRoot || {}),
        [normalizedWorkspaceRoot]: current,
      };
      this.save();
    }
    return current;
  }

  getApprovalPromptState(threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const raw = this.state.approvalPromptStateByThreadId?.[normalizedThreadId];
    if (!raw || typeof raw !== "object") {
      return null;
    }
    return {
      requestId: normalizeValue(raw.requestId),
      signature: normalizeValue(raw.signature),
      promptedAt: normalizeValue(raw.promptedAt),
    };
  }

  rememberApprovalPrompt(threadId, requestId, signature = "") {
    const normalizedThreadId = normalizeValue(threadId);
    const normalizedRequestId = normalizeValue(requestId);
    const normalizedSignature = normalizeValue(signature);
    if (!normalizedThreadId || !normalizedRequestId) {
      return null;
    }
    this.state.approvalPromptStateByThreadId = {
      ...(this.state.approvalPromptStateByThreadId || {}),
      [normalizedThreadId]: {
        requestId: normalizedRequestId,
        signature: normalizedSignature,
        promptedAt: new Date().toISOString(),
      },
    };
    this.save();
    return this.getApprovalPromptState(normalizedThreadId);
  }

  clearApprovalPrompt(threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId || !this.state.approvalPromptStateByThreadId?.[normalizedThreadId]) {
      return;
    }
    const next = {
      ...(this.state.approvalPromptStateByThreadId || {}),
    };
    delete next[normalizedThreadId];
    this.state.approvalPromptStateByThreadId = next;
    this.save();
  }

  getAvailableModelCatalog() {
    const raw = this.state.availableModelCatalog;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const models = normalizeModelCatalog(raw.models);
    if (!models.length) {
      return null;
    }
    const updatedAt = normalizeValue(raw.updatedAt);
    return { models, updatedAt };
  }

  setAvailableModelCatalog(models) {
    const normalizedModels = normalizeModelCatalog(models);
    if (!normalizedModels.length) {
      return null;
    }
    this.state.availableModelCatalog = {
      models: normalizedModels,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.availableModelCatalog;
  }

  buildBindingKey({ workspaceId, accountId, senderId }) {
    return `${normalizeValue(workspaceId)}:${normalizeValue(accountId)}:${normalizeValue(senderId)}`;
  }
}

function createEmptyState() {
  return {
    bindings: {},
    approvalCommandAllowlistByWorkspaceRoot: {},
    approvalPromptStateByThreadId: {},
    availableModelCatalog: {
      models: [],
      updatedAt: "",
    },
  };
}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeThreadValue(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function getLegacyThreadMap(binding) {
  return binding?.threadIdByWorkspaceRoot && typeof binding.threadIdByWorkspaceRoot === "object"
    ? binding.threadIdByWorkspaceRoot
    : {};
}

function getThreadRuntimeMap(binding) {
  return binding?.threadIdByWorkspaceRootByRuntime && typeof binding.threadIdByWorkspaceRootByRuntime === "object"
    ? binding.threadIdByWorkspaceRootByRuntime
    : {};
}

function getThreadMapForRuntime(binding, runtimeId) {
  const normalizedRuntimeId = normalizeValue(runtimeId);
  const runtimeMap = getThreadRuntimeMap(binding);
  if (!normalizedRuntimeId) {
    return {};
  }
  const scoped = runtimeMap[normalizedRuntimeId];
  return scoped && typeof scoped === "object" ? scoped : {};
}

function getCodexParamsMap(binding) {
  return binding?.codexParamsByWorkspaceRoot && typeof binding.codexParamsByWorkspaceRoot === "object"
    ? binding.codexParamsByWorkspaceRoot
    : {};
}

function getRuntimeParamsRuntimeMap(binding) {
  return binding?.runtimeParamsByWorkspaceRootByRuntime && typeof binding.runtimeParamsByWorkspaceRootByRuntime === "object"
    ? binding.runtimeParamsByWorkspaceRootByRuntime
    : {};
}

function getRuntimeParamsMapForRuntime(binding, runtimeId) {
  const normalizedRuntimeId = normalizeValue(runtimeId);
  if (!normalizedRuntimeId) {
    return {};
  }
  const scoped = getRuntimeParamsRuntimeMap(binding)[normalizedRuntimeId];
  return scoped && typeof scoped === "object" ? scoped : {};
}

function isSameTokenList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function normalizeWorkspacePath(rawPath, platform = process.platform) {
  if (typeof rawPath !== "string") {
    return "";
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return "";
  }
  if (platform === "win32") {
    const normalized = path.win32.normalize(trimmed);
    return normalized.toLowerCase();
  }
  return path.posix.normalize(trimmed);
}

function migrateSessionStoreState(rawState, platform = process.platform) {
  if (!rawState || typeof rawState !== "object") {
    return createEmptyState();
  }

  const migrated = {
    ...createEmptyState(),
    ...rawState,
    bindings: {},
    approvalCommandAllowlistByWorkspaceRoot: {},
    approvalPromptStateByThreadId: rawState.approvalPromptStateByThreadId || {},
    availableModelCatalog: rawState.availableModelCatalog || {
      models: [],
      updatedAt: "",
    },
  };

  const rawBindings = rawState.bindings && typeof rawState.bindings === "object" ? rawState.bindings : {};
  for (const [bindingKey, binding] of Object.entries(rawBindings)) {
    if (!binding || typeof binding !== "object") {
      migrated.bindings[bindingKey] = binding;
      continue;
    }

    const activeRaw = typeof binding.activeWorkspaceRoot === "string" ? binding.activeWorkspaceRoot.trim() : "";
    const activeCanonical = normalizeWorkspacePath(activeRaw, platform);

    const consolidateWorkspaceMap = (rawMap, resolveConflict) => {
      if (!rawMap || typeof rawMap !== "object") return {};
      const canonicalMap = {};
      for (const [rawKey, val] of Object.entries(rawMap)) {
        const canonicalKey = normalizeWorkspacePath(rawKey, platform);
        if (!canonicalKey) continue;
        if (!Object.prototype.hasOwnProperty.call(canonicalMap, canonicalKey)) {
          canonicalMap[canonicalKey] = { val, rawKey };
        } else {
          const existing = canonicalMap[canonicalKey];
          const chosen = resolveConflict(existing.val, val, existing.rawKey, rawKey, canonicalKey);
          canonicalMap[canonicalKey] = chosen;
        }
      }
      const result = {};
      for (const [k, entry] of Object.entries(canonicalMap)) {
        result[k] = entry.val;
      }
      return result;
    };

    const resolveThreadConflict = (valA, valB, keyA, keyB, canonicalKey, runtimeId) => {
      const threadA = normalizeThreadValue(valA);
      const threadB = normalizeThreadValue(valB);
      if (!threadA && threadB) return { val: threadB, rawKey: keyB };
      if (threadA && !threadB) return { val: threadA, rawKey: keyA };
      if (threadA === threadB) return { val: threadA, rawKey: keyA };

      const matchesActiveExactA = keyA === activeRaw;
      const matchesActiveExactB = keyB === activeRaw;
      if (matchesActiveExactA && !matchesActiveExactB) {
        console.warn(
          `[cyberboss] session-store merged conflicting workspace keys for binding="${bindingKey}" runtime="${runtimeId}" canonical="${canonicalKey}": preserved active workspace thread="${threadA}" (${keyA}) over "${threadB}" (${keyB})`
        );
        return { val: threadA, rawKey: keyA };
      }
      if (matchesActiveExactB && !matchesActiveExactA) {
        console.warn(
          `[cyberboss] session-store merged conflicting workspace keys for binding="${bindingKey}" runtime="${runtimeId}" canonical="${canonicalKey}": preserved active workspace thread="${threadB}" (${keyB}) over "${threadA}" (${keyA})`
        );
        return { val: threadB, rawKey: keyB };
      }

      const chosen = keyA > keyB ? { val: threadA, rawKey: keyA } : { val: threadB, rawKey: keyB };
      console.warn(
        `[cyberboss] session-store migrated conflicting workspace keys for binding="${bindingKey}" runtime="${runtimeId}" canonical="${canonicalKey}": resolved to thread="${chosen.val}" (candidates: ${keyA}=${threadA}, ${keyB}=${threadB})`
      );
      return chosen;
    };

    const migratedThreadIdByWorkspaceRootByRuntime = {};
    const rawRuntimes = getThreadRuntimeMap(binding);
    for (const [runtimeId, runtimeMap] of Object.entries(rawRuntimes)) {
      migratedThreadIdByWorkspaceRootByRuntime[runtimeId] = consolidateWorkspaceMap(
        runtimeMap,
        (valA, valB, keyA, keyB, cKey) => resolveThreadConflict(valA, valB, keyA, keyB, cKey, runtimeId)
      );
    }

    const migratedRuntimeParamsByWorkspaceRootByRuntime = {};
    const rawParamRuntimes = getRuntimeParamsRuntimeMap(binding);
    for (const [runtimeId, paramMap] of Object.entries(rawParamRuntimes)) {
      migratedRuntimeParamsByWorkspaceRootByRuntime[runtimeId] = consolidateWorkspaceMap(
        paramMap,
        (valA, valB, keyA, keyB) => {
          if (keyB === activeRaw) return { val: valB, rawKey: keyB };
          if (keyA === activeRaw) return { val: valA, rawKey: keyA };
          return (valB?.model || valB?.modelProvider) ? { val: valB, rawKey: keyB } : { val: valA, rawKey: keyA };
        }
      );
    }

    const migratedLegacyThreadMap = consolidateWorkspaceMap(
      getLegacyThreadMap(binding),
      (valA, valB, keyA, keyB, cKey) => resolveThreadConflict(valA, valB, keyA, keyB, cKey, "codex-legacy")
    );
    const migratedLegacyParamsMap = consolidateWorkspaceMap(
      getCodexParamsMap(binding),
      (valA, valB, keyA, keyB) => (keyB === activeRaw ? { val: valB, rawKey: keyB } : { val: valA, rawKey: keyA })
    );

    migrated.bindings[bindingKey] = {
      ...binding,
      activeWorkspaceRoot: activeCanonical,
      threadIdByWorkspaceRootByRuntime: migratedThreadIdByWorkspaceRootByRuntime,
      runtimeParamsByWorkspaceRootByRuntime: migratedRuntimeParamsByWorkspaceRootByRuntime,
      ...(binding.threadIdByWorkspaceRoot ? { threadIdByWorkspaceRoot: migratedLegacyThreadMap } : {}),
      ...(binding.codexParamsByWorkspaceRoot ? { codexParamsByWorkspaceRoot: migratedLegacyParamsMap } : {}),
    };
  }

  const rawAllowlists = rawState.approvalCommandAllowlistByWorkspaceRoot;
  if (rawAllowlists && typeof rawAllowlists === "object") {
    for (const [rawWorkspace, tokensList] of Object.entries(rawAllowlists)) {
      const canonicalKey = normalizeWorkspacePath(rawWorkspace, platform);
      if (!canonicalKey || !Array.isArray(tokensList)) continue;
      const existing = migrated.approvalCommandAllowlistByWorkspaceRoot[canonicalKey] || [];
      for (const tokens of tokensList) {
        if (!existing.some((e) => isSameTokenList(e, tokens))) {
          existing.push(tokens);
        }
      }
      migrated.approvalCommandAllowlistByWorkspaceRoot[canonicalKey] = existing;
    }
  }

  return migrated;
}

module.exports = {
  SessionStore,
  normalizeWorkspacePath,
  migrateSessionStoreState,
};
