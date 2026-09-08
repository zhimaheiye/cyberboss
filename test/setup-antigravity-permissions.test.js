const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveTargetRules } = require("../scripts/setup-antigravity-permissions");
const { computeAntigravityServerName } = require("../src/adapters/runtime/antigravity/mcp-settings");

function runTest() {
  console.log("==================================================");
  console.log("Running Setup Antigravity Permissions Unit Tests");
  console.log("==================================================");

  // 1. Test rule resolution
  const testWorkspace = process.platform === "win32" ? "D:\\test\\cyberboss" : "/tmp/test/cyberboss";
  const expectedServer = computeAntigravityServerName(testWorkspace);
  const resolved = resolveTargetRules({
    stateDir: path.join(os.tmpdir(), "cb-test-state"),
    workspaceRoot: testWorkspace,
  });

  assert.strictEqual(resolved.serverName, expectedServer, "Server name should match computeAntigravityServerName");
  assert.strictEqual(resolved.mcpRule, `mcp(${expectedServer}/*)`, "MCP rule must be scoped to specific server");
  assert(resolved.readFileRule.startsWith("read_file("), "Read file rule must start with read_file(");
  assert(!resolved.mcpRule.includes("mcp(*)"), "MCP rule must not be wildcard");
  console.log("RULE_RESOLUTION_PASS");

  // 2. Integration test with temp settings file
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-perm-test-"));
  const tempSettingsPath = path.join(tempDir, "settings.json");
  const tempStateDir = path.join(tempDir, "state");
  const scriptPath = path.resolve(__dirname, "..", "scripts", "setup-antigravity-permissions.js");

  const expectedAppliedRules = resolveTargetRules({
    stateDir: tempStateDir,
    workspaceRoot: testWorkspace,
  });

  const env = {
    ...process.env,
    CYBERBOSS_ANTIGRAVITY_SETTINGS_PATH: tempSettingsPath,
    CYBERBOSS_STATE_DIR: tempStateDir,
    CYBERBOSS_WORKSPACE_ROOT: testWorkspace,
  };

  try {
    // A. Apply on fresh settings (file does not exist)
    const resApply1 = spawnSync(process.execPath, [scriptPath, "--apply"], { env, encoding: "utf8" });
    assert.strictEqual(resApply1.status, 0, `Apply failed: ${resApply1.stderr}`);
    assert(resApply1.stdout.includes("MINIMAL_PERMISSION_APPLIED_PASS"), "Must report MINIMAL_PERMISSION_APPLIED_PASS");
    assert(fs.existsSync(tempSettingsPath), "settings.json must be created");

    const settings1 = JSON.parse(fs.readFileSync(tempSettingsPath, "utf8"));
    assert(settings1.permissions.allow.includes(expectedAppliedRules.mcpRule), "settings must contain mcpRule");
    assert(settings1.permissions.allow.includes(expectedAppliedRules.readFileRule), "settings must contain readFileRule");
    console.log("APPLY_FRESH_PASS");

    // B. Idempotence: second apply should report PERMISSION_ALREADY_PRESENT and not duplicate
    const resApply2 = spawnSync(process.execPath, [scriptPath, "--apply"], { env, encoding: "utf8" });
    assert.strictEqual(resApply2.status, 0);
    assert(resApply2.stdout.includes("PERMISSION_ALREADY_PRESENT"), "Second apply must be idempotent");

    const settings2 = JSON.parse(fs.readFileSync(tempSettingsPath, "utf8"));
    const mcpCount = settings2.permissions.allow.filter((r) => r === expectedAppliedRules.mcpRule).length;
    assert.strictEqual(mcpCount, 1, "Rule must not be duplicated");
    console.log("IDEMPOTENT_APPLY_PASS");

    // C. Show mode
    const resShow = spawnSync(process.execPath, [scriptPath, "--show"], { env, encoding: "utf8" });
    assert.strictEqual(resShow.status, 0);
    assert(resShow.stdout.includes("ALREADY_PRESENT"), "Show mode should report ALREADY_PRESENT");
    console.log("SHOW_MODE_PASS");

    // D. Conflict detection in deny
    const settingsWithConflict = {
      permissions: {
        allow: [],
        deny: ["mcp(*)"],
      },
    };
    fs.writeFileSync(tempSettingsPath, JSON.stringify(settingsWithConflict));
    const resConflict = spawnSync(process.execPath, [scriptPath, "--apply"], { env, encoding: "utf8" });
    assert.strictEqual(resConflict.status, 1, "Must exit 1 on conflict");
    assert(resConflict.stderr.includes("CONFLICTING_PERMISSION_RULE"), "Must output CONFLICTING_PERMISSION_RULE");
    console.log("CONFLICT_DENY_PASS");

    // E. Corrupted JSON rejection
    fs.writeFileSync(tempSettingsPath, "{ invalid json ...", "utf8");
    const resCorrupt = spawnSync(process.execPath, [scriptPath, "--apply"], { env, encoding: "utf8" });
    assert.strictEqual(resCorrupt.status, 1, "Must exit 1 on corrupted json");
    assert.strictEqual(fs.readFileSync(tempSettingsPath, "utf8"), "{ invalid json ...", "Corrupted file must not be overwritten");
    console.log("CORRUPTED_JSON_GUARD_PASS");

    // F. Remove mode
    fs.writeFileSync(tempSettingsPath, JSON.stringify({
      permissions: {
        allow: [expectedAppliedRules.mcpRule, expectedAppliedRules.readFileRule, "other_rule"],
      },
    }));
    const resRemove = spawnSync(process.execPath, [scriptPath, "--remove"], { env, encoding: "utf8" });
    assert.strictEqual(resRemove.status, 0);
    assert(resRemove.stdout.includes("PERMISSION_REMOVED"), "Must report PERMISSION_REMOVED");

    const settingsRemoved = JSON.parse(fs.readFileSync(tempSettingsPath, "utf8"));
    assert(!settingsRemoved.permissions.allow.includes(expectedAppliedRules.mcpRule), "mcpRule must be removed");
    assert(!settingsRemoved.permissions.allow.includes(expectedAppliedRules.readFileRule), "readFileRule must be removed");
    assert(settingsRemoved.permissions.allow.includes("other_rule"), "other_rule must be preserved");
    console.log("REMOVE_PASS");

    console.log("==================================================");
    console.log("ALL PERMISSION SETUP TESTS PASSED!");
    console.log("==================================================");
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

runTest();
