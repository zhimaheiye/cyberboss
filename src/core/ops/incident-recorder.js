const fs = require("fs");
const path = require("path");
const { sanitizeText } = require("./sanitize");

const DEFAULT_FAILURE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_INCIDENT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_FAILURE_THRESHOLD = 3;
const MAX_FAILURE_HISTORY = 10;

class IncidentRecorder {
  constructor({
    opsDir,
    failureThreshold = DEFAULT_FAILURE_THRESHOLD,
    failureWindowMs = DEFAULT_FAILURE_WINDOW_MS,
    incidentCooldownMs = DEFAULT_INCIDENT_COOLDOWN_MS,
  } = {}) {
    this.opsDir = opsDir || path.join(process.cwd(), ".cyberboss", "ops");
    this.healthFile = path.join(this.opsDir, "runtime-health.json");
    this.incidentsDir = path.join(this.opsDir, "incidents");
    this.failureThreshold = failureThreshold;
    this.failureWindowMs = failureWindowMs;
    this.incidentCooldownMs = incidentCooldownMs;

    this.state = this.loadState();
  }

  buildScopeKey(runtimeId, workspaceRoot) {
    const r = typeof runtimeId === "string" ? runtimeId.trim() : "default";
    const w = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "default";
    return `${r}\0${w}`;
  }

  ensureDirs() {
    if (!fs.existsSync(this.opsDir)) {
      fs.mkdirSync(this.opsDir, { recursive: true });
    }
    if (!fs.existsSync(this.incidentsDir)) {
      fs.mkdirSync(this.incidentsDir, { recursive: true });
    }
  }

  loadState() {
    this.ensureDirs();
    if (!fs.existsSync(this.healthFile)) {
      return { scopes: {}, globalFailureHistory: [] };
    }

    try {
      const raw = fs.readFileSync(this.healthFile, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          scopes: parsed.scopes || {},
          globalFailureHistory: Array.isArray(parsed.globalFailureHistory) ? parsed.globalFailureHistory : [],
        };
      }
    } catch (err) {
      console.warn(`[cyberboss-ops] runtime-health.json corrupted, backing up and resetting: ${err.message}`);
      const backupPath = path.join(this.opsDir, `runtime-health.json.corrupt.${Date.now()}`);
      try {
        fs.renameSync(this.healthFile, backupPath);
      } catch {
        // ignore
      }
    }

    return { scopes: {}, globalFailureHistory: [] };
  }

  saveState() {
    this.ensureDirs();
    const tempFile = path.join(this.opsDir, `runtime-health.json.tmp.${Date.now()}.${Math.random().toString(16).slice(2)}`);
    const data = JSON.stringify(this.state, null, 2);
    fs.writeFileSync(tempFile, data, "utf-8");
    fs.renameSync(tempFile, this.healthFile);
  }

  getScopeState(runtimeId, workspaceRoot) {
    const key = this.buildScopeKey(runtimeId, workspaceRoot);
    if (!this.state.scopes[key]) {
      this.state.scopes[key] = {
        runtimeId,
        workspaceRoot,
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastSuccessAt: null,
        lastIncidentAt: null,
        lastIncidentClassification: null,
        failureHistory: [],
      };
    }
    return this.state.scopes[key];
  }

  recordTurnResult({
    runtimeId = "antigravity",
    workspaceRoot = "",
    threadId = "",
    turnId = "",
    success = false,
    classification = "UNKNOWN_ERROR",
    attemptCount = 1,
    finalError = "",
    toolActivity = false,
    autoRetried = false,
    retrySuccess = false,
  }) {
    const scope = this.getScopeState(runtimeId, workspaceRoot);
    const now = new Date();
    const nowIso = now.toISOString();
    let createdIncident = null;

    if (success) {
      scope.consecutiveFailures = 0;
      scope.lastSuccessAt = nowIso;
      this.saveState();
      return { success: true, consecutiveFailures: 0, incident: null };
    }

    // Failure branch
    scope.consecutiveFailures += 1;
    scope.lastFailureAt = nowIso;

    const sanitizedError = sanitizeText(finalError || classification);
    const failureRecord = {
      timestamp: nowIso,
      classification,
      error: sanitizedError,
      attemptCount,
      toolActivity,
      autoRetried,
      retrySuccess,
      threadId: sanitizeText(threadId),
      turnId: sanitizeText(turnId),
    };

    scope.failureHistory.push(failureRecord);
    if (scope.failureHistory.length > MAX_FAILURE_HISTORY) {
      scope.failureHistory.shift();
    }

    // Evaluate incident creation
    if (scope.consecutiveFailures >= this.failureThreshold) {
      const windowStart = now.getTime() - this.failureWindowMs;
      // Filter recent failures within window
      const recentFailuresInWindow = scope.failureHistory.filter((f) => {
        const time = new Date(f.timestamp).getTime();
        return time >= windowStart;
      });

      if (recentFailuresInWindow.length >= this.failureThreshold) {
        // Check cooldown
        const lastIncidentTime = scope.lastIncidentAt ? new Date(scope.lastIncidentAt).getTime() : 0;
        const cooldownElapsed = now.getTime() - lastIncidentTime;
        const isSameClassification = scope.lastIncidentClassification === classification;

        if (!isSameClassification || cooldownElapsed >= this.incidentCooldownMs) {
          createdIncident = this.createIncident({
            runtimeId,
            workspaceRoot,
            classification,
            failureCount: scope.consecutiveFailures,
            lastSuccessAt: scope.lastSuccessAt,
            autoRetried,
            retrySuccess,
            toolActivity,
            recentFailures: recentFailuresInWindow,
          });

          scope.lastIncidentAt = nowIso;
          scope.lastIncidentClassification = classification;
        }
      }
    }

    this.saveState();
    return {
      success: false,
      consecutiveFailures: scope.consecutiveFailures,
      incident: createdIncident,
    };
  }

  recordSuccess(runtimeId = "antigravity", workspaceRoot = "") {
    return this.recordTurnResult({
      runtimeId,
      workspaceRoot,
      success: true,
    });
  }

  recordFailure({
    runtime = "antigravity",
    runtimeId,
    workspaceRoot = "",
    error = "",
    classification,
    turnContext = {},
    recentEvents = [],
  } = {}) {
    const effectiveRuntime = runtimeId || runtime || "antigravity";
    const msg = error instanceof Error ? error.message : String(error || "");
    const effectiveClassification = classification || turnContext.classification || "UNKNOWN_ERROR";
    return this.recordTurnResult({
      runtimeId: effectiveRuntime,
      workspaceRoot,
      threadId: turnContext.threadId || "",
      turnId: turnContext.turnId || "",
      success: false,
      classification: effectiveClassification,
      attemptCount: turnContext.attempt || 1,
      finalError: msg,
      toolActivity: Boolean(turnContext.toolActivity),
      autoRetried: Boolean(turnContext.autoRetried),
      retrySuccess: false,
    });
  }

  createIncident({
    runtimeId,
    workspaceRoot,
    classification,
    failureCount,
    lastSuccessAt,
    autoRetried,
    retrySuccess,
    toolActivity,
    recentFailures = [],
    extraLogs = null,
  }) {
    this.ensureDirs();
    const now = new Date();
    // Format timestamp without colons for Windows directory compatibility: YYYY-MM-DDTHH-mm-ss
    const safeTimestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeClassification = String(classification || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const safeRuntime = String(runtimeId || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const incidentDirName = `${safeTimestamp}_${safeRuntime}_${safeClassification}`;
    const incidentDir = path.join(this.incidentsDir, incidentDirName);

    fs.mkdirSync(incidentDir, { recursive: true });

    const summaryData = {
      incidentId: incidentDirName,
      timestamp: now.toISOString(),
      runtime: runtimeId,
      classification,
      workspace: workspaceRoot,
      failureCount,
      windowMs: this.failureWindowMs,
      autoRetried,
      retrySuccess,
      toolActivity,
      lastSuccessAt: lastSuccessAt || "never",
      recentFailures,
    };

    // 1. summary.json
    fs.writeFileSync(path.join(incidentDir, "summary.json"), JSON.stringify(summaryData, null, 2), "utf-8");

    // 2. summary.md
    const summaryMd = [
      `# Incident: ${incidentDirName}`,
      "",
      `**Runtime**: \`${runtimeId}\``,
      `**Classification**: \`${classification}\``,
      `**Workspace**: \`${workspaceRoot}\``,
      `**Timestamp**: ${now.toISOString()}`,
      `**Consecutive Failures**: ${failureCount}`,
      `**Last Success**: ${lastSuccessAt || "never"}`,
      `**Automatic Retry Attempted**: ${autoRetried ? "yes" : "no"}`,
      `**Automatic Retry Succeeded**: ${retrySuccess ? "yes" : "no"}`,
      `**Tool Activity Observed**: ${toolActivity ? "yes" : "no"}`,
      "",
      "## Recent Failures",
      "",
      ...recentFailures.map((f, i) => [
        `### Failure #${i + 1} (${f.timestamp})`,
        `- **Classification**: \`${f.classification}\``,
        `- **Error**: \`${f.error}\``,
        `- **Attempts**: ${f.attemptCount}`,
        `- **Tool Activity**: ${f.toolActivity ? "yes" : "no"}`,
        f.turnId ? `- **Turn ID**: \`${f.turnId}\`` : "",
        f.threadId ? `- **Thread ID**: \`${f.threadId}\`` : "",
      ].filter(Boolean).join("\n")),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(incidentDir, "summary.md"), summaryMd, "utf-8");

    // 3. maintenance-prompt.txt
    const maintenancePrompt = [
      "CyberBoss Antigravity runtime 连续失败。",
      "",
      `runtime: ${runtimeId}`,
      `classification: ${classification}`,
      `workspace: ${workspaceRoot}`,
      `last success: ${lastSuccessAt || "never"}`,
      `failure count: ${failureCount}`,
      `automatic retry attempted: ${autoRetried ? "yes" : "no"}`,
      `automatic retry succeeded: ${retrySuccess ? "yes" : "no"}`,
      `tool activity observed: ${toolActivity ? "yes" : "no"}`,
      "",
      "请只调查本 incident。",
      "不要切换 runtime。",
      "不要修改人格。",
      "不要修改微信绑定。",
      "先检查附带状态和最近错误，再做最小修复。",
    ].join("\n");
    fs.writeFileSync(path.join(incidentDir, "maintenance-prompt.txt"), maintenancePrompt, "utf-8");

    // Optional recent.log for watchdog or crash logs
    if (extraLogs && typeof extraLogs === "string") {
      fs.writeFileSync(path.join(incidentDir, "sanitized-recent.log"), sanitizeText(extraLogs), "utf-8");
    }

    console.warn(`[cyberboss-ops] Incident created: ${incidentDir}`);
    return {
      incidentId: incidentDirName,
      incidentDir,
      summaryData,
    };
  }

  recordCrashLoopIncident({
    runtimeId = "cyberboss",
    workspaceRoot = process.cwd(),
    crashCount = 3,
    recentLogs = [],
  }) {
    const joinedLogs = Array.isArray(recentLogs) ? recentLogs.join("\n") : String(recentLogs || "");
    return this.createIncident({
      runtimeId,
      workspaceRoot,
      classification: "PROCESS_CRASH_LOOP",
      failureCount: crashCount,
      lastSuccessAt: null,
      autoRetried: false,
      retrySuccess: false,
      toolActivity: false,
      recentFailures: [
        {
          timestamp: new Date().toISOString(),
          classification: "PROCESS_CRASH_LOOP",
          error: "Process exited repeatedly exceeding crash loop threshold",
          attemptCount: crashCount,
          toolActivity: false,
        },
      ],
      extraLogs: joinedLogs,
    });
  }
}

module.exports = {
  IncidentRecorder,
  DEFAULT_FAILURE_WINDOW_MS,
  DEFAULT_INCIDENT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  MAX_FAILURE_HISTORY,
};
