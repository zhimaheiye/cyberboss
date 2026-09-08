const fs = require("fs");
const os = require("os");
const path = require("path");

const { computeAntigravityServerName } = require("../src/adapters/runtime/antigravity/mcp-settings");

function loadEnv() {
  try {
    const dotenv = require("dotenv");
    const projectEnv = path.resolve(__dirname, "..", ".env");
    if (fs.existsSync(projectEnv)) {
      dotenv.config({ path: projectEnv });
      return;
    }
    const homeEnv = path.join(os.homedir(), ".cyberboss", ".env");
    if (fs.existsSync(homeEnv)) {
      dotenv.config({ path: homeEnv });
    }
  } catch {
    // dotenv not strictly required if env vars are already set
  }
}

function normalizeForAntigravityPermissionPath(absPath) {
  // Antigravity CLI on Windows uses forward slashes with drive letter (e.g. C:/Users/...)
  let resolved = path.resolve(absPath).replace(/\\/g, "/");
  return resolved;
}

function getSettingsPath() {
  if (process.env.CYBERBOSS_ANTIGRAVITY_SETTINGS_PATH) {
    return path.resolve(process.env.CYBERBOSS_ANTIGRAVITY_SETTINGS_PATH);
  }
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
}

function readSettingsFile(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return { settings: {}, rawText: "{}", exists: false };
  }
  const rawText = fs.readFileSync(settingsPath, "utf-8");
  try {
    const settings = JSON.parse(rawText);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("Invalid settings object");
    }
    return { settings, rawText, exists: true };
  } catch {
    console.error("Failed to parse existing Antigravity settings.");
    console.error("No changes were made.");
    process.exit(1);
  }
}

function resolveTargetRules({ stateDir, workspaceRoot } = {}) {
  const resolvedStateDir = stateDir || process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
  const inboxDir = path.join(resolvedStateDir, "inbox");
  const normalizedPath = normalizeForAntigravityPermissionPath(inboxDir);
  const readFileRule = `read_file(${normalizedPath})`;

  const resolvedWorkspaceRoot = workspaceRoot || process.env.CYBERBOSS_WORKSPACE_ROOT || process.cwd();
  const serverName = computeAntigravityServerName(resolvedWorkspaceRoot);
  const mcpRule = `mcp(${serverName}/*)`;

  return {
    stateDir: resolvedStateDir,
    inboxDir,
    normalizedPath,
    workspaceRoot: resolvedWorkspaceRoot,
    serverName,
    readFileRule,
    mcpRule,
    targetRules: [readFileRule, mcpRule],
  };
}

function main() {
  loadEnv();

  const args = process.argv.slice(2);
  let mode = "--show";
  let customWorkspaceRoot = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--show" || args[i] === "--apply" || args[i] === "--remove") {
      mode = args[i];
    } else if (args[i] === "--workspace-root" && args[i + 1]) {
      customWorkspaceRoot = args[++i];
    }
  }

  const {
    stateDir,
    inboxDir,
    normalizedPath,
    workspaceRoot,
    serverName,
    readFileRule,
    mcpRule,
    targetRules,
  } = resolveTargetRules({ workspaceRoot: customWorkspaceRoot });

  const settingsPath = getSettingsPath();
  const { settings, exists } = readSettingsFile(settingsPath);

  const permissions = settings.permissions || {};
  const allowList = Array.isArray(permissions.allow) ? permissions.allow : [];
  const askList = Array.isArray(permissions.ask) ? permissions.ask : [];
  const denyList = Array.isArray(permissions.deny) ? permissions.deny : [];

  console.log("==================================================");
  console.log("Antigravity Permissions Setup for Cyberboss");
  console.log("==================================================");
  console.log(`Settings path: ${settingsPath}`);
  console.log(`Cyberboss stateDir: ${stateDir}`);
  console.log(`Cyberboss inbox: ${inboxDir}`);
  console.log(`Normalized inbox path: ${normalizedPath}`);
  console.log(`Workspace root: ${workspaceRoot}`);
  console.log(`Target MCP server: ${serverName}`);
  console.log(`Antigravity read rule: ${readFileRule}`);
  console.log(`Antigravity MCP rule: ${mcpRule}`);
  console.log("Existing allow rules:", allowList.filter((r) => typeof r === "string" && (r.includes("read_file") || r.includes("write_file") || r.includes("mcp"))));
  console.log("Existing ask rules:", askList.filter((r) => typeof r === "string" && (r.includes("read_file") || r.includes("write_file") || r.includes("mcp"))));
  console.log("Existing deny rules:", denyList.filter((r) => typeof r === "string" && (r.includes("read_file") || r.includes("write_file") || r.includes("mcp"))));

  const allRulesPresent = targetRules.every((r) => allowList.includes(r));

  if (mode === "--show") {
    console.log(`\nRule status: ${allRulesPresent ? "ALREADY_PRESENT" : "NOT_PRESENT"}`);
    for (const rule of targetRules) {
      console.log(`  ${rule}: ${allowList.includes(rule) ? "PRESENT" : "MISSING"}`);
    }
    return;
  }

  if (mode === "--apply") {
    // Check conflicts for read_file
    const conflictReadFileDeny = denyList.some((r) => r === "read_file(*)" || r === readFileRule);
    const conflictReadFileAsk = askList.some((r) => r === "read_file(*)" || r === readFileRule);

    // Check conflicts for mcp
    const conflictMcpDeny = denyList.some((r) => r === "mcp(*)" || r === mcpRule);
    const conflictMcpAsk = askList.some((r) => r === "mcp(*)" || r === mcpRule);

    const conflictInDeny = conflictReadFileDeny || conflictMcpDeny;
    const conflictInAsk = conflictReadFileAsk || conflictMcpAsk;
    if (conflictInDeny || conflictInAsk) {
      console.error("\nCONFLICTING_PERMISSION_RULE");
      console.error(`Conflict found in deny: ${conflictInDeny} (read=${conflictReadFileDeny}, mcp=${conflictMcpDeny}), in ask: ${conflictInAsk} (read=${conflictReadFileAsk}, mcp=${conflictMcpAsk})`);
      process.exit(1);
    }

    if (allowList.includes("read_file(*)")) {
      console.warn("\nWARNING: EXISTING_BROAD_READ_PERMISSION detected in allow list (read_file(*))");
    }
    if (allowList.includes("mcp(*)")) {
      console.warn("\nWARNING: EXISTING_BROAD_MCP_PERMISSION detected in allow list (mcp(*))");
    }

    if (allRulesPresent) {
      console.log("\nPERMISSION_ALREADY_PRESENT");
      console.log("MINIMAL_PERMISSION_APPLIED_PASS");
      return;
    }

    // Create backup if settings file exists
    if (exists) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const backupPath = `${settingsPath}.cyberboss-stage5-${ts}.bak`;
      fs.copyFileSync(settingsPath, backupPath);
      console.log(`\nCreated backup: ${backupPath}`);
    } else {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    }

    // Apply rules
    settings.permissions = settings.permissions || {};
    settings.permissions.allow = settings.permissions.allow || [];
    for (const rule of targetRules) {
      if (!settings.permissions.allow.includes(rule)) {
        settings.permissions.allow.push(rule);
      }
    }

    // Atomic write
    const newContent = JSON.stringify(settings, null, 2) + "\n";
    const tempPath = `${settingsPath}.tmp-${Date.now()}`;
    fs.writeFileSync(tempPath, newContent, "utf-8");

    // Verify temp file
    JSON.parse(fs.readFileSync(tempPath, "utf-8"));
    fs.renameSync(tempPath, settingsPath);

    console.log("PERMISSION_APPLIED");

    // Verification
    const reloaded = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const verified =
      reloaded.permissions &&
      Array.isArray(reloaded.permissions.allow) &&
      targetRules.every((r) => reloaded.permissions.allow.includes(r));

    if (verified) {
      console.log("MINIMAL_PERMISSION_APPLIED_PASS");
    } else {
      console.error("Verification failed after apply");
      process.exit(1);
    }
    return;
  }

  if (mode === "--remove") {
    const anyPresent = targetRules.some((r) => allowList.includes(r));
    if (!exists || !anyPresent) {
      console.log("\nPERMISSION_NOT_PRESENT");
      return;
    }

    settings.permissions.allow = settings.permissions.allow.filter((r) => !targetRules.includes(r));
    const newContent = JSON.stringify(settings, null, 2) + "\n";
    const tempPath = `${settingsPath}.tmp-${Date.now()}`;
    fs.writeFileSync(tempPath, newContent, "utf-8");
    JSON.parse(fs.readFileSync(tempPath, "utf-8"));
    fs.renameSync(tempPath, settingsPath);

    console.log("\nPERMISSION_REMOVED");
    return;
  }

  console.error(`Unknown mode: ${mode}. Supported: --show, --apply, --remove`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  getSettingsPath,
  readSettingsFile,
  normalizeForAntigravityPermissionPath,
  resolveTargetRules,
  main,
};
