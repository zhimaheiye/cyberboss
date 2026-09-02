const fs = require("fs");
const os = require("os");
const path = require("path");

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
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
}

function readSettingsFile(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return { settings: {}, rawText: "{}", exists: false };
  }
  const rawText = fs.readFileSync(settingsPath, "utf-8");
  try {
    const settings = JSON.parse(rawText);
    return { settings, rawText, exists: true };
  } catch {
    console.error("Failed to parse existing Antigravity settings.");
    console.error("No changes were made.");
    process.exit(1);
  }
}

function main() {
  loadEnv();

  const args = process.argv.slice(2);
  const mode = args[0] || "--show";

  const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
  const inboxDir = path.join(stateDir, "inbox");
  const normalizedPath = normalizeForAntigravityPermissionPath(inboxDir);
  const targetRule = `read_file(${normalizedPath})`;

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
  console.log(`Normalized path: ${normalizedPath}`);
  console.log(`Antigravity rule: ${targetRule}`);
  console.log("Existing allow rules:", allowList.filter((r) => typeof r === "string" && (r.includes("read_file") || r.includes("write_file"))));
  console.log("Existing ask rules:", askList.filter((r) => typeof r === "string" && (r.includes("read_file") || r.includes("write_file"))));
  console.log("Existing deny rules:", denyList.filter((r) => typeof r === "string" && (r.includes("read_file") || r.includes("write_file"))));

  const isRulePresent = allowList.includes(targetRule);

  if (mode === "--show") {
    console.log(`\nRule status: ${isRulePresent ? "ALREADY_PRESENT" : "NOT_PRESENT"}`);
    return;
  }

  if (mode === "--apply") {
    // Check conflicts
    const conflictInDeny = denyList.some((r) => r === "read_file(*)" || r === targetRule);
    const conflictInAsk = askList.some((r) => r === "read_file(*)" || r === targetRule);
    if (conflictInDeny || conflictInAsk) {
      console.error("\nCONFLICTING_PERMISSION_RULE");
      console.error(`Conflict found in deny: ${conflictInDeny}, in ask: ${conflictInAsk}`);
      process.exit(1);
    }

    if (allowList.includes("read_file(*)")) {
      console.warn("\nWARNING: EXISTING_BROAD_READ_PERMISSION detected in allow list (read_file(*))");
    }

    if (isRulePresent) {
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

    // Apply rule
    settings.permissions = settings.permissions || {};
    settings.permissions.allow = settings.permissions.allow || [];
    settings.permissions.allow.push(targetRule);

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
    if (
      reloaded.permissions &&
      Array.isArray(reloaded.permissions.allow) &&
      reloaded.permissions.allow.includes(targetRule)
    ) {
      console.log("MINIMAL_PERMISSION_APPLIED_PASS");
    } else {
      console.error("Verification failed after apply");
      process.exit(1);
    }
    return;
  }

  if (mode === "--remove") {
    if (!exists || !isRulePresent) {
      console.log("\nPERMISSION_NOT_PRESENT");
      return;
    }

    settings.permissions.allow = settings.permissions.allow.filter((r) => r !== targetRule);
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

main();
