const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readConfig } = require("../src/core/config");

const REAL_COMMAND = process.env.CYBERBOSS_ANTIGRAVITY_COMMAND || "antigravity";
const PROJECT_ROOT = path.resolve(__dirname, "..");

function testConfigRegistration() {
  console.log("==================================================");
  console.log("Test A: readConfig Antigravity Registration");
  console.log("==================================================");

  const envBackup = { ...process.env };

  try {
    process.env.CYBERBOSS_RUNTIME = "antigravity";
    process.env.CYBERBOSS_ANTIGRAVITY_COMMAND = REAL_COMMAND;
    process.env.CYBERBOSS_ANTIGRAVITY_MODEL = "stage3-test-model";
    process.env.CYBERBOSS_ANTIGRAVITY_EFFORT = "high";
    process.env.CYBERBOSS_ANTIGRAVITY_EXTRA_ARGS = "--mode,plan";
    process.env.CYBERBOSS_ANTIGRAVITY_TIMEOUT_MS = "45000";

    const config = readConfig();

    assert.strictEqual(config.runtime, "antigravity", "config.runtime must be antigravity");
    assert.strictEqual(config.antigravityCommand, REAL_COMMAND, "antigravityCommand must match REAL_COMMAND");
    assert.strictEqual(config.antigravityModel, "stage3-test-model", "antigravityModel must match");
    assert.strictEqual(config.antigravityEffort, "high", "antigravityEffort must match");
    assert.deepStrictEqual(config.antigravityExtraArgs, ["--mode", "plan"], "antigravityExtraArgs must match");
    assert.strictEqual(config.antigravityTimeoutMs, 45000, "antigravityTimeoutMs must be 45000");

    console.log("CONFIG_REGISTRATION_PASS");
  } finally {
    process.env = envBackup;
  }
}

function testDoctorRegistration() {
  console.log("\n==================================================");
  console.log("Test B: Real Doctor Antigravity Integration");
  console.log("==================================================");

  const tmpStateDir = path.join(os.tmpdir(), `cyberboss-doctor-${Date.now()}`);
  const tmpWorkspace = path.join(tmpStateDir, "workspace");
  fs.mkdirSync(tmpWorkspace, { recursive: true });

  try {
    const res = spawnSync(
      process.execPath,
      ["./bin/cyberboss.js", "doctor"],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          CYBERBOSS_RUNTIME: "antigravity",
          CYBERBOSS_STATE_DIR: tmpStateDir,
          CYBERBOSS_WORKSPACE_ROOT: tmpWorkspace,
          CYBERBOSS_ANTIGRAVITY_COMMAND: REAL_COMMAND,
        },
        encoding: "utf-8",
      }
    );

    const output = (res.stdout || "") + (res.stderr || "");
    console.log("Doctor output:\n" + output);

    assert.strictEqual(res.status, 0, `doctor must exit with 0, got ${res.status}`);
    assert(output.includes('"id": "antigravity"'), 'doctor output must contain "id": "antigravity"');
    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.runtime.id, "antigravity");
    assert.strictEqual(parsed.runtime.command, REAL_COMMAND);
    assert(!output.includes('"id": "codex"'), 'doctor output must NOT describe runtime as "id": "codex"');
    assert(!output.includes('"id": "claudecode"'), 'doctor output must NOT describe runtime as "id": "claudecode"');

    console.log("DOCTOR_ANTIGRAVITY_PASS");
  } finally {
    try {
      fs.rmSync(tmpStateDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function testUnknownRuntimeGuard() {
  console.log("\n==================================================");
  console.log("Test C: Unknown Runtime Guard");
  console.log("==================================================");

  const tmpStateDir = path.join(os.tmpdir(), `cyberboss-guard-${Date.now()}`);
  fs.mkdirSync(tmpStateDir, { recursive: true });

  try {
    const res = spawnSync(
      process.execPath,
      ["./bin/cyberboss.js", "doctor"],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          CYBERBOSS_RUNTIME: "this-runtime-does-not-exist",
          CYBERBOSS_STATE_DIR: tmpStateDir,
        },
        encoding: "utf-8",
      }
    );

    const output = (res.stdout || "") + (res.stderr || "");
    assert.notStrictEqual(res.status, 0, "doctor must fail for unknown runtime");
    assert(
      output.includes("Unsupported CYBERBOSS_RUNTIME"),
      `Expected 'Unsupported CYBERBOSS_RUNTIME' error, got: ${output}`
    );

    console.log("UNKNOWN_RUNTIME_GUARD_PASS");
  } finally {
    try {
      fs.rmSync(tmpStateDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function testSharedOpenGuard() {
  console.log("\n==================================================");
  console.log("Test D: shared:open Security Guard");
  console.log("==================================================");

  const res = spawnSync(
    process.execPath,
    ["./scripts/shared-open.js"],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        CYBERBOSS_RUNTIME: "antigravity",
      },
      encoding: "utf-8",
    }
  );

  const output = (res.stdout || "") + (res.stderr || "");
  assert.notStrictEqual(res.status, 0, "shared-open must exit with non-zero for antigravity");
  assert(
    output.includes("Antigravity shared:open is not implemented yet"),
    `Expected unimplemented message, got: ${output}`
  );
  assert(
    !output.includes("Claude IPC socket not found"),
    `shared-open must NOT fallback to Claude IPC, got: ${output}`
  );

  console.log("SHARED_OPEN_GUARD_PASS");
}

function main() {
  testConfigRegistration();
  testDoctorRegistration();
  testUnknownRuntimeGuard();
  testSharedOpenGuard();
  console.log("\n==================================================");
  console.log("ALL STAGE 3 REGISTRATION TESTS PASSED 100%!");
  console.log("==================================================");
}

main();
