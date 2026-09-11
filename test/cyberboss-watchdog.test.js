const path = require("path");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const {
  CyberbossWatchdog,
} = require("../scripts/cyberboss-watchdog");
const { IncidentRecorder } = require("../src/core/ops/incident-recorder");

async function runTests() {
  console.log("Running CyberbossWatchdog integration test suite...\n");
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

  const tmpBase = path.join(os.tmpdir(), `cyberboss-watchdog-test-${Date.now()}`);
  fs.mkdirSync(tmpBase, { recursive: true });

  try {
    await testCase("Child exits cleanly (code 0) -> watchdog does not restart and halts", async () => {
      const helperScript = path.join(tmpBase, "clean-exit-helper.js");
      fs.writeFileSync(helperScript, 'console.log("child normal work done"); process.exit(0);', "utf-8");

      const opsDir = path.join(tmpBase, "w1-ops");
      const recorder = new IncidentRecorder({ opsDir });

      const watchdog = new CyberbossWatchdog({
        targetScript: helperScript,
        targetArgs: [],
        restartDelayMs: 20,
        incidentRecorder: recorder,
      });

      const result = await watchdog.start();
      assert.strictEqual(result.code, 0);
      assert.strictEqual(watchdog.running, false);
      assert.strictEqual(watchdog.crashHistory.length, 0);
    });

    await testCase("Crash loop: 3 crashes within window creates incident and halts watchdog", async () => {
      const helperScript = path.join(tmpBase, "crash-loop-helper.js");
      // Script prints secret token and exits 1
      fs.writeFileSync(
        helperScript,
        'console.log("booting child with token Bearer ya29.secret_token_val"); console.error("critical crash"); process.exit(1);',
        "utf-8"
      );

      const opsDir = path.join(tmpBase, "w2-ops");
      const recorder = new IncidentRecorder({ opsDir });

      const watchdog = new CyberbossWatchdog({
        targetScript: helperScript,
        targetArgs: [],
        restartDelayMs: 15,
        maxCrashes: 3,
        crashWindowMs: 60000,
        incidentRecorder: recorder,
      });

      const result = await watchdog.start();
      assert.ok(result.crashLoop, "Result must indicate crash loop threshold reached");
      assert.strictEqual(watchdog.running, false);
      assert.strictEqual(watchdog.crashHistory.length, 3);

      // Verify incident directory was created
      const incidentsDir = path.join(opsDir, "incidents");
      assert.ok(fs.existsSync(incidentsDir));
      const list = fs.readdirSync(incidentsDir);
      assert.ok(list.length >= 1, "Must have created incident directory");

      const incDir = path.join(incidentsDir, list[0]);
      const summaryJson = JSON.parse(fs.readFileSync(path.join(incDir, "summary.json"), "utf-8"));
      assert.strictEqual(summaryJson.classification, "PROCESS_CRASH_LOOP");

      const logFile = path.join(incDir, "sanitized-recent.log");
      assert.ok(fs.existsSync(logFile));
      const logContent = fs.readFileSync(logFile, "utf-8");
      assert.ok(!logContent.includes("secret_token_val"));
      assert.ok(logContent.includes("Bearer <redacted>"));
    });

    await testCase("Intentional shutdown (stop) terminates child and does not restart", async () => {
      const helperScript = path.join(tmpBase, "long-running-helper.js");
      fs.writeFileSync(
        helperScript,
        'console.log("running forever..."); setInterval(() => {}, 1000);',
        "utf-8"
      );

      const opsDir = path.join(tmpBase, "w3-ops");
      const recorder = new IncidentRecorder({ opsDir });

      const watchdog = new CyberbossWatchdog({
        targetScript: helperScript,
        targetArgs: [],
        restartDelayMs: 20,
        incidentRecorder: recorder,
      });

      const startPromise = watchdog.start();
      await new Promise((r) => setTimeout(r, 60));

      assert.ok(watchdog.running);
      assert.ok(watchdog.child);

      await watchdog.stop("SIGTERM");
      await startPromise;

      assert.strictEqual(watchdog.running, false);
      assert.strictEqual(watchdog.crashHistory.length, 0, "Intentional shutdown must not record crash");
    });

    await testCase("Ring buffer caps at configured size", async () => {
      const watchdog = new CyberbossWatchdog({
        ringBufferSize: 5,
      });

      for (let i = 1; i <= 10; i++) {
        watchdog.appendLog(`line ${i}`);
      }

      assert.strictEqual(watchdog.ringBuffer.length, 5);
      assert.strictEqual(watchdog.ringBuffer[0], "line 6");
      assert.strictEqual(watchdog.ringBuffer[4], "line 10");
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
