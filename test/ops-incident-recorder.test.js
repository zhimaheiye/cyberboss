const fs = require("fs");
const path = require("path");
const assert = require("assert");
const os = require("os");
const {
  IncidentRecorder,
  DEFAULT_FAILURE_THRESHOLD,
} = require("../src/core/ops/incident-recorder");
const { sanitizeText } = require("../src/core/ops/sanitize");

async function runTests() {
  console.log("Running IncidentRecorder unit test suite...\n");
  let passed = 0;
  let failed = 0;

  async function testCase(name, fn) {
    try {
      await fn();
      console.log(`  PASS: ${name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL: ${name}`);
      console.error(err);
      failed += 1;
    }
  }

  const tmpBase = path.join(os.tmpdir(), `cyberboss-ops-test-${Date.now()}`);
  fs.mkdirSync(tmpBase, { recursive: true });

  try {
    await testCase("Scope tracking & success resets consecutive failures", async () => {
      const opsDir = path.join(tmpBase, "t1");
      const recorder = new IncidentRecorder({ opsDir });

      recorder.recordTurnResult({
        runtimeId: "antigravity",
        workspaceRoot: "d:\\workspace-a",
        success: false,
        classification: "STREAM_INTERRUPTED",
      });
      recorder.recordTurnResult({
        runtimeId: "antigravity",
        workspaceRoot: "d:\\workspace-a",
        success: false,
        classification: "STREAM_INTERRUPTED",
      });

      const scope = recorder.getScopeState("antigravity", "d:\\workspace-a");
      assert.strictEqual(scope.consecutiveFailures, 2);

      recorder.recordSuccess("antigravity", "d:\\workspace-a");
      assert.strictEqual(scope.consecutiveFailures, 0);
      assert.ok(scope.lastSuccessAt);
    });

    await testCase("3 consecutive failures within 15m creates incident with 3 required files", async () => {
      const opsDir = path.join(tmpBase, "t2");
      const recorder = new IncidentRecorder({ opsDir, failureThreshold: 3 });

      const r1 = recorder.recordTurnResult({
        runtimeId: "antigravity",
        workspaceRoot: "d:\\workspace-b",
        success: false,
        classification: "STREAM_INTERRUPTED",
        finalError: "The stream was interrupted. Please continue.",
      });
      assert.strictEqual(r1.incident, null);

      const r2 = recorder.recordTurnResult({
        runtimeId: "antigravity",
        workspaceRoot: "d:\\workspace-b",
        success: false,
        classification: "STREAM_INTERRUPTED",
        finalError: "The stream was interrupted. Please continue.",
      });
      assert.strictEqual(r2.incident, null);

      const r3 = recorder.recordTurnResult({
        runtimeId: "antigravity",
        workspaceRoot: "d:\\workspace-b",
        success: false,
        classification: "STREAM_INTERRUPTED",
        finalError: "The stream was interrupted. Please continue.",
      });
      assert.ok(r3.incident, "Incident should be created on 3rd failure");
      assert.ok(fs.existsSync(r3.incident.incidentDir));

      const summaryJson = path.join(r3.incident.incidentDir, "summary.json");
      const summaryMd = path.join(r3.incident.incidentDir, "summary.md");
      const promptTxt = path.join(r3.incident.incidentDir, "maintenance-prompt.txt");

      assert.ok(fs.existsSync(summaryJson), "summary.json must exist");
      assert.ok(fs.existsSync(summaryMd), "summary.md must exist");
      assert.ok(fs.existsSync(promptTxt), "maintenance-prompt.txt must exist");

      const parsedSummary = JSON.parse(fs.readFileSync(summaryJson, "utf-8"));
      assert.strictEqual(parsedSummary.classification, "STREAM_INTERRUPTED");
      assert.strictEqual(parsedSummary.failureCount, 3);
      assert.strictEqual(parsedSummary.recentFailures.length, 3);

      const promptContent = fs.readFileSync(promptTxt, "utf-8");
      assert.ok(promptContent.includes("CyberBoss Antigravity runtime 连续失败"));
      assert.ok(promptContent.includes("STREAM_INTERRUPTED"));
    });

    await testCase("Cooldown prevents duplicate incident within 30m for same classification", async () => {
      const opsDir = path.join(tmpBase, "t3");
      const recorder = new IncidentRecorder({ opsDir, failureThreshold: 3, incidentCooldownMs: 30 * 60 * 1000 });

      for (let i = 0; i < 3; i++) {
        recorder.recordTurnResult({
          runtimeId: "antigravity",
          workspaceRoot: "d:\\workspace-c",
          success: false,
          classification: "AUTH_REQUIRED",
          finalError: "AGY authentication required",
        });
      }

      // 4th failure immediately after
      const r4 = recorder.recordTurnResult({
        runtimeId: "antigravity",
        workspaceRoot: "d:\\workspace-c",
        success: false,
        classification: "AUTH_REQUIRED",
        finalError: "AGY authentication required",
      });
      assert.strictEqual(r4.incident, null, "Should be silenced by cooldown");

      // 5th failure with different classification should bypass cooldown
      const r5 = recorder.recordTurnResult({
        runtimeId: "antigravity",
        workspaceRoot: "d:\\workspace-c",
        success: false,
        classification: "STREAM_INTERRUPTED",
        finalError: "Stream interrupted",
      });
      // But consecutiveFailures of STREAM_INTERRUPTED in window might differ, wait:
      // In t3, consecutive failures is 5, recentFailures contains both
      assert.ok(r5.incident, "Different classification creates incident despite cooldown");
      assert.strictEqual(r5.incident.summaryData.classification, "STREAM_INTERRUPTED");
    });

    await testCase("Sensitive data (Bearer token, password, query code) is redacted in incident reports", async () => {
      const opsDir = path.join(tmpBase, "t4");
      const recorder = new IncidentRecorder({ opsDir, failureThreshold: 1 });

      const r = recorder.recordTurnResult({
        runtimeId: "antigravity",
        workspaceRoot: "d:\\workspace-d",
        success: false,
        classification: "PROXY_REFUSED",
        finalError: "Connect failed http://user:secret123@127.0.0.1:7890 with Bearer ya29.a0AfH6SM-token and code=4/0AQl_secret",
      });

      assert.ok(r.incident);
      const summaryJson = fs.readFileSync(path.join(r.incident.incidentDir, "summary.json"), "utf-8");
      assert.ok(!summaryJson.includes("secret123"));
      assert.ok(!summaryJson.includes("ya29.a0AfH6SM-token"));
      assert.ok(!summaryJson.includes("4/0AQl_secret"));
      assert.ok(summaryJson.includes("<redacted>"));
    });

    await testCase("Corrupt runtime-health.json is recovered gracefully with backup", async () => {
      const opsDir = path.join(tmpBase, "t5");
      fs.mkdirSync(opsDir, { recursive: true });
      const healthFile = path.join(opsDir, "runtime-health.json");
      fs.writeFileSync(healthFile, "{ malformed json garbage... ", "utf-8");

      const recorder = new IncidentRecorder({ opsDir });
      assert.deepStrictEqual(recorder.state.scopes, {});

      // Verify backup was created
      const files = fs.readdirSync(opsDir);
      const backupFile = files.find((f) => f.startsWith("runtime-health.json.corrupt."));
      assert.ok(backupFile, "Backup of corrupt file must exist");
    });

    await testCase("recordCrashLoopIncident creates PROCESS_CRASH_LOOP incident with sanitized logs", async () => {
      const opsDir = path.join(tmpBase, "t6");
      const recorder = new IncidentRecorder({ opsDir });

      const result = recorder.recordCrashLoopIncident({
        runtimeId: "antigravity",
        workspaceRoot: "d:\\cyberboss",
        crashCount: 3,
        recentLogs: [
          "[stdout] starting shared bridge runtime=antigravity",
          "[stderr] error with authorization Bearer secret-tok-123456",
          "[stderr] crash with status 1",
        ],
      });

      assert.ok(result);
      assert.strictEqual(result.summaryData.classification, "PROCESS_CRASH_LOOP");
      const logFile = path.join(result.incidentDir, "sanitized-recent.log");
      assert.ok(fs.existsSync(logFile), "sanitized-recent.log must exist");
      const logContent = fs.readFileSync(logFile, "utf-8");
      assert.ok(!logContent.includes("secret-tok-123456"));
      assert.ok(logContent.includes("Bearer <redacted>"));
    });
  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
