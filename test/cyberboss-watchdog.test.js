const path = require("path");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const EventEmitter = require("events");
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
    await testCase("1. SIGINT: stop promise does NOT resolve before child close, resolves only after child close, and does NOT restart", async () => {
      let closeDelayMs = 80;
      let childClosed = false;

      class MockWatchdog extends CyberbossWatchdog {
        _spawnChild() {
          return new Promise((resolve) => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.killed = false;
            child.kill = (sig) => {
              child.killed = true;
              setTimeout(() => {
                childClosed = true;
                this.child = null;
                resolve({ code: null, signal: sig });
              }, closeDelayMs);
            };

            this.child = child;
          });
        }
      }

      const opsDir = path.join(tmpBase, "w-sigint");
      const recorder = new IncidentRecorder({ opsDir });
      const watchdog = new MockWatchdog({
        restartDelayMs: 20,
        incidentRecorder: recorder,
      });

      const startPromise = watchdog.start();
      assert.strictEqual(watchdog.running, true);
      assert.ok(watchdog.child);

      let stopPromiseResolved = false;
      const stopPromise = watchdog.stop("SIGINT").then((res) => {
        stopPromiseResolved = true;
        return res;
      });

      // At 20ms, child is still alive in mock
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(childClosed, false, "Child should still be alive at 20ms");
      assert.strictEqual(stopPromiseResolved, false, "Stop promise MUST NOT resolve before child closes");

      // Wait for child close and stop promise
      const stopResult = await stopPromise;
      const startResult = await startPromise;

      assert.strictEqual(childClosed, true, "Child must have closed");
      assert.strictEqual(stopPromiseResolved, true, "Stop promise must resolve after child closes");
      assert.strictEqual(watchdog.running, false);
      assert.strictEqual(watchdog.intentionalShutdown, true);
      assert.strictEqual(watchdog.crashHistory.length, 0, "Intentional SIGINT must not be counted as a crash");
      assert.strictEqual(stopResult.intentional, true);
      assert.strictEqual(startResult.intentional, true);
    });

    await testCase("2. SIGTERM: stop promise does NOT resolve before child close, resolves only after child close, and does NOT restart", async () => {
      let closeDelayMs = 80;
      let childClosed = false;

      class MockWatchdog extends CyberbossWatchdog {
        _spawnChild() {
          return new Promise((resolve) => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.killed = false;
            child.kill = (sig) => {
              child.killed = true;
              setTimeout(() => {
                childClosed = true;
                this.child = null;
                resolve({ code: null, signal: sig });
              }, closeDelayMs);
            };

            this.child = child;
          });
        }
      }

      const opsDir = path.join(tmpBase, "w-sigterm");
      const recorder = new IncidentRecorder({ opsDir });
      const watchdog = new MockWatchdog({
        restartDelayMs: 20,
        incidentRecorder: recorder,
      });

      const startPromise = watchdog.start();
      assert.strictEqual(watchdog.running, true);

      let stopPromiseResolved = false;
      const stopPromise = watchdog.stop("SIGTERM").then((res) => {
        stopPromiseResolved = true;
        return res;
      });

      // At 20ms, child has not closed yet
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(childClosed, false);
      assert.strictEqual(stopPromiseResolved, false, "Stop promise MUST NOT resolve before child closes");

      const stopResult = await stopPromise;
      await startPromise;

      assert.strictEqual(childClosed, true);
      assert.strictEqual(stopPromiseResolved, true);
      assert.strictEqual(watchdog.running, false);
      assert.strictEqual(watchdog.crashHistory.length, 0, "Intentional SIGTERM must not record crash");
      assert.strictEqual(stopResult.intentional, true);
    });

    await testCase("3. No-child stop: can stop immediately when child is not running", async () => {
      const opsDir = path.join(tmpBase, "w-nochild");
      const recorder = new IncidentRecorder({ opsDir });

      const watchdog = new CyberbossWatchdog({
        incidentRecorder: recorder,
      });

      // Stop before start
      assert.strictEqual(watchdog.child, null);
      const res = await watchdog.stop();
      assert.strictEqual(res.intentional, true);
      assert.strictEqual(res.code, 0);

      // Start after stop should resolve immediately
      const startRes = await watchdog.start();
      assert.strictEqual(startRes.intentional, true);
    });

    await testCase("4. Child exits cleanly (code 0) -> watchdog does not restart and halts", async () => {
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

    await testCase("5. Crash loop: 3 crashes within window creates incident and halts watchdog", async () => {
      const helperScript = path.join(tmpBase, "crash-loop-helper.js");
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

    await testCase("6. Ring buffer caps at configured size", async () => {
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
