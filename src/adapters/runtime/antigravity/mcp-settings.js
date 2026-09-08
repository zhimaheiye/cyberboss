const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

function ensureAntigravityGlobalMcpConfig({ workspaceRoot, cyberbossHome = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    throw new Error("workspaceRoot is required to configure Antigravity project tools.");
  }

  const agyAppData = path.join(os.homedir(), ".gemini", "antigravity");
  if (!fs.existsSync(agyAppData)) {
    fs.mkdirSync(agyAppData, { recursive: true });
  }

  const configPath = path.join(agyAppData, "mcp_config.json");
  const current = readJsonObject(configPath) || {};
  if (!current.mcpServers || typeof current.mcpServers !== "object") {
    current.mcpServers = {};
  }

  const hash = crypto.createHash("md5").update(normalizedWorkspaceRoot).digest("hex").slice(0, 8);
  const serverName = `cyberboss_tools_${hash}`;

  const next = {
    ...current,
    mcpServers: {
      ...current.mcpServers,
      [serverName]: buildAntigravityProjectMcpServerConfig({
        workspaceRoot: normalizedWorkspaceRoot,
        cyberbossHome,
      }),
    },
  };

  if (!jsonEquals(current, next)) {
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  }

  return {
    configPath,
    serverName,
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

function readJsonObject(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ensureAntigravityGlobalMcpConfig,
  buildAntigravityProjectMcpServerConfig,
};
