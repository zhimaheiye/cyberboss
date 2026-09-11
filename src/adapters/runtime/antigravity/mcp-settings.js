const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

function resolveAntigravityMcpConfigPath(options = {}) {
  if (options.configPath && typeof options.configPath === "string") {
    return path.resolve(options.configPath);
  }
  if (process.env.CYBERBOSS_ANTIGRAVITY_MCP_CONFIG_PATH) {
    return path.resolve(process.env.CYBERBOSS_ANTIGRAVITY_MCP_CONFIG_PATH);
  }
  const baseDir =
    (options.agyConfigDir && typeof options.agyConfigDir === "string" ? options.agyConfigDir : "") ||
    process.env.CYBERBOSS_ANTIGRAVITY_CONFIG_DIR ||
    path.join(os.homedir(), ".gemini", "config");
  return path.join(path.resolve(baseDir), "mcp_config.json");
}

function ensureAntigravityGlobalMcpConfig({
  workspaceRoot,
  cyberbossHome = "",
  configPath = "",
  agyConfigDir = "",
} = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    throw new Error("workspaceRoot is required to configure Antigravity project tools.");
  }

  const targetConfigPath = resolveAntigravityMcpConfigPath({ configPath, agyConfigDir });
  const configDir = path.dirname(targetConfigPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const current = readJsonObject(targetConfigPath) || {};
  if (!current.mcpServers || typeof current.mcpServers !== "object") {
    current.mcpServers = {};
  }

  const canonicalCurrentWorkspace = canonicalizeWorkspaceRoot(normalizedWorkspaceRoot);
  const canonicalServerName = computeAntigravityServerName(normalizedWorkspaceRoot);

  const prunedServers = {};
  for (const [existingName, existingEntry] of Object.entries(current.mcpServers)) {
    if (isCyberbossMcpServerEntry(existingName, existingEntry)) {
      const existingWs = extractWorkspaceRootFromEntry(existingEntry);
      const canonicalExistingWs = canonicalizeWorkspaceRoot(existingWs);
      if (canonicalExistingWs === canonicalCurrentWorkspace && existingName !== canonicalServerName) {
        // Prune stale duplicate entry for the same canonical workspace
        continue;
      }
    }
    prunedServers[existingName] = existingEntry;
  }

  prunedServers[canonicalServerName] = buildAntigravityProjectMcpServerConfig({
    workspaceRoot: normalizedWorkspaceRoot,
    cyberbossHome,
  });

  const next = {
    ...current,
    mcpServers: prunedServers,
  };

  if (!jsonEquals(current, next)) {
    const tempPath = targetConfigPath + `.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(next, null, 2) + "\n", "utf8");
    fs.renameSync(tempPath, targetConfigPath);
  }

  return {
    configPath: targetConfigPath,
    serverName: canonicalServerName,
    config: next,
  };
}

function buildAntigravityProjectMcpServerConfig({ workspaceRoot, cyberbossHome = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  const home = normalizeText(cyberbossHome) || process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "cyberboss.js");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Cyberboss MCP entrypoint not found: ${scriptPath}`);
  }
  return {
    command: process.execPath,
    args: [scriptPath, "tool-mcp-server", "--runtime-id", "antigravity", "--workspace-root", normalizedWorkspaceRoot],
  };
}

function isCyberbossMcpServerEntry(serverName, entry) {
  if (typeof serverName !== "string" || !serverName.startsWith("cyberboss_tools_")) {
    return false;
  }
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const args = entry.args;
  if (!Array.isArray(args)) {
    return false;
  }
  const toolIdx = args.indexOf("tool-mcp-server");
  const runtimeIdx = args.indexOf("--runtime-id");
  const wsIdx = args.indexOf("--workspace-root");
  if (toolIdx === -1 || runtimeIdx === -1 || wsIdx === -1) {
    return false;
  }
  if (args[runtimeIdx + 1] !== "antigravity") {
    return false;
  }
  if (!args[wsIdx + 1] || typeof args[wsIdx + 1] !== "string") {
    return false;
  }
  return true;
}

function extractWorkspaceRootFromEntry(entry) {
  if (!entry || !Array.isArray(entry.args)) {
    return null;
  }
  const idx = entry.args.indexOf("--workspace-root");
  if (idx !== -1 && idx + 1 < entry.args.length && typeof entry.args[idx + 1] === "string") {
    return entry.args[idx + 1];
  }
  return null;
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  return null;
}

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalizeWorkspaceRoot(workspaceRoot) {
  const normalized = normalizeText(workspaceRoot);
  if (!normalized) return "";
  const resolved = path.resolve(normalized);
  return process.platform === "win32"
    ? resolved.toLowerCase().replace(/\\/g, "/")
    : resolved;
}

function computeAntigravityServerName(workspaceRoot) {
  const pathForHash = canonicalizeWorkspaceRoot(workspaceRoot);
  const hash = crypto.createHash("md5").update(pathForHash).digest("hex").slice(0, 8);
  return `cyberboss_tools_${hash}`;
}

module.exports = {
  ensureAntigravityGlobalMcpConfig,
  buildAntigravityProjectMcpServerConfig,
  computeAntigravityServerName,
  canonicalizeWorkspaceRoot,
  isCyberbossMcpServerEntry,
  extractWorkspaceRootFromEntry,
  resolveAntigravityMcpConfigPath,
};
