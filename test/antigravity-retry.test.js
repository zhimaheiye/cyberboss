const cp = require("child_process");
const path = require("path");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const EventEmitter = require("events");

const originalSpawn = cp.spawn;
let spawnHandler = null;

cp.spawn = function (command, args, options) {
  if (spawnHandler && (command === "mock-agy-retry" || command === "antigravity")) {
    return spawnHandler(command, args, options);
  }
  return originalSpawn(command, args, options);
};

const { createAntigravityRuntimeAdapter } = require("../src/adapters/runtime/antigravity/index");
const { IncidentRecorder } = require("../src/core/ops/incident-recorder");

function createMockChild({
  events = [],
  stderr = "",
  exitCode = 0,
  delayMs = 5,
  onSpawn = null,
}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = () => {};
  child.stdin.end = () => {};
  child.kill = (sig) => {
    child.killed = true;
    setTimeout(() => {
      child.emit("close", null, sig || "SIGTERM");
    }, 5);
  };
  child.killed = false;

  setImmediate(async () => {
    if (onSpawn) onSpawn();
    for (const evt of events) {
      if (child.killed) return;
      if (typeof evt === "object") {
        child.stdout.emit("data", Buffer.from(JSON.stringify(evt) + "\n"));
      } else {
        child.stdout.emit("data", Buffer.from(evt + "\n"));
      }
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    if (stderr) {
      child.stderr.emit("data", Buffer.from(stderr));
    }
    if (!child.killed) {
      child.emit("close", exitCode, null);
    }
  });

  return child;
}

async function runTests() {
  console.log("Running Antigravity Retry and Self-Healing integration test suite...\n");
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

  const tmpBase = path.join(os.tmpdir(), `cyberboss-retry-test-${Date.now()}`);
  fs.mkdirSync(tmpBase, { recursive: true });
  process.env.CYBERBOSS_ANTIGRAVITY_MCP_CONFIG_PATH = path.join(tmpBase, "mcp_config.json");

  try {
    await testCase("Scenario 1: Attempt 1 stream interrupted -> Attempt 2 succeeds with conversation ID", async () => {
      const spawns = [];
      spawnHandler = (command, args) => {
        spawns.push({ command, args: [...args] });
        if (spawns.length === 1) {
          // Attempt 1: emit init with conv-s1, then stream interrupted
          return createMockChild({
            events: [
              { event: "init", conversation_id: "conv-s1" },
              {
                event: "result",
                result: {
                  conversation_id: "conv-s1",
                  status: "ERROR",
                  error: "The stream was interrupted. Please continue the task you were working on.",
                },
              },
            ],
            exitCode: 1,
          });
        }
        // Attempt 2: successful reply
        return createMockChild({
          events: [
            { event: "init", conversation_id: "conv-s1" },
            {
              event: "result",
              result: {
                conversation_id: "conv-s1",
                status: "SUCCESS",
                response: "Hello! Resumed cleanly after stream interruption.",
                usage: { total_tokens: 50 },
              },
            },
          ],
          exitCode: 0,
        });
      };

      const emittedEvents = [];
      const opsDir = path.join(tmpBase, "s1-ops");
      const sessionsFile = path.join(tmpBase, "s1-sessions.json");
      const adapter = createAntigravityRuntimeAdapter({
        antigravityCommand: "mock-agy-retry",
        antigravityStreamRetryDelayMs: 20,
        antigravityStreamRetryMax: 1,
        opsDir,
        sessionsFile,
      });
      adapter.onEvent((evt) => emittedEvents.push(evt));

      const res = await adapter.sendTurn({
        bindingKey: "user-1",
        workspaceRoot: "d:\\workspace-retry",
        text: "User original request",
      });

      assert.strictEqual(spawns.length, 2, "Expected exactly 2 process spawns");
      assert.strictEqual(res.threadId, "conv-s1");

      // Verify Attempt 2 included --conversation conv-s1
      const attempt2Args = spawns[1].args;
      const convIndex = attempt2Args.indexOf("--conversation");
      assert.ok(convIndex >= 0, "Attempt 2 must include --conversation flag");
      assert.strictEqual(attempt2Args[convIndex + 1], "conv-s1");

      // Verify events: runtime.turn.failed must NOT have been emitted
      const failedEvents = emittedEvents.filter((e) => e.type === "runtime.turn.failed");
      assert.strictEqual(failedEvents.length, 0, "Should NOT emit runtime.turn.failed for transparent retry");

      const completedEvents = emittedEvents.filter((e) => e.type === "runtime.turn.completed");
      assert.strictEqual(completedEvents.length, 1, "Should emit runtime.turn.completed on successful retry");
      assert.strictEqual(completedEvents[0].payload.text, "Hello! Resumed cleanly after stream interruption.");

      // Check incident recorder state
      const health = adapter.getIncidentRecorder().getScopeState("antigravity", "d:\\workspace-retry");
      assert.strictEqual(health.consecutiveFailures, 0);
      assert.ok(health.lastSuccessAt);
    });

    await testCase("Scenario 2: Stream interrupted on both Attempt 1 and 2 -> emits failure and records failure", async () => {
      const spawns = [];
      spawnHandler = (command, args) => {
        spawns.push({ command, args });
        return createMockChild({
          events: [
            { event: "init", conversation_id: "conv-s2" },
            {
              event: "result",
              result: {
                conversation_id: "conv-s2",
                status: "ERROR",
                error: "The stream was interrupted. Please continue the task you were working on.",
              },
            },
          ],
          exitCode: 1,
        });
      };

      const emittedEvents = [];
      const opsDir = path.join(tmpBase, "s2-ops");
      const sessionsFile = path.join(tmpBase, "s2-sessions.json");
      const adapter = createAntigravityRuntimeAdapter({
        antigravityCommand: "mock-agy-retry",
        antigravityStreamRetryDelayMs: 15,
        antigravityStreamRetryMax: 1,
        opsDir,
        sessionsFile,
      });
      adapter.onEvent((evt) => emittedEvents.push(evt));

      let threw = false;
      try {
        await adapter.sendTurn({
          bindingKey: "user-2",
          workspaceRoot: "d:\\workspace-retry-2",
          text: "Will fail twice",
        });
      } catch (err) {
        threw = true;
        assert.ok(err.message.includes("stream was interrupted"));
      }

      assert.ok(threw, "Must throw error when all retries are exhausted");
      assert.strictEqual(spawns.length, 2, "Expected 2 process spawns (attempt 1 + retry 1)");

      const failedEvents = emittedEvents.filter((e) => e.type === "runtime.turn.failed");
      assert.strictEqual(failedEvents.length, 1, "Should emit exactly 1 runtime.turn.failed event");

      const health = adapter.getIncidentRecorder().getScopeState("antigravity", "d:\\workspace-retry-2");
      assert.strictEqual(health.consecutiveFailures, 1);
    });

    await testCase("Scenario 3: Attempt 1 had tool call evidence -> does NOT retry to protect against side effects", async () => {
      const spawns = [];
      spawnHandler = (command, args) => {
        spawns.push({ command, args });
        return createMockChild({
          events: [
            { event: "init", conversation_id: "conv-s3" },
            {
              event: "step_update",
              step_type: "tool",
              tool_name: "cyberboss_diary_append",
              tool_calls: [{ id: "call_1", function: { name: "cyberboss_diary_append" } }],
            },
            {
              event: "result",
              result: {
                conversation_id: "conv-s3",
                status: "ERROR",
                error: "The stream was interrupted. Please continue the task you were working on.",
              },
            },
          ],
          exitCode: 1,
        });
      };

      const opsDir = path.join(tmpBase, "s3-ops");
      const sessionsFile = path.join(tmpBase, "s3-sessions.json");
      const adapter = createAntigravityRuntimeAdapter({
        antigravityCommand: "mock-agy-retry",
        antigravityStreamRetryDelayMs: 10,
        antigravityStreamRetryMax: 1,
        opsDir,
        sessionsFile,
      });

      let threw = false;
      try {
        await adapter.sendTurn({
          bindingKey: "user-3",
          workspaceRoot: "d:\\workspace-retry-3",
          text: "Append diary",
        });
      } catch (err) {
        threw = true;
      }

      assert.ok(threw);
      assert.strictEqual(spawns.length, 1, "Must NOT retry when tool calls were observed during attempt");
    });

    await testCase("Scenario 4: Non-retryable error (AUTH_REQUIRED) -> does NOT retry", async () => {
      const spawns = [];
      spawnHandler = (command, args) => {
        spawns.push({ command, args });
        return createMockChild({
          events: [
            {
              event: "result",
              result: {
                status: "ERROR",
                error: "Authentication required. Please visit the URL to log in.",
              },
            },
          ],
          stderr: "authentication failed or timed out",
          exitCode: 1,
        });
      };

      const opsDir = path.join(tmpBase, "s4-ops");
      const sessionsFile = path.join(tmpBase, "s4-sessions.json");
      const adapter = createAntigravityRuntimeAdapter({
        antigravityCommand: "mock-agy-retry",
        antigravityStreamRetryDelayMs: 10,
        opsDir,
        sessionsFile,
      });

      let threw = false;
      try {
        await adapter.sendTurn({
          bindingKey: "user-4",
          workspaceRoot: "d:\\workspace-retry-4",
          text: "Auth test",
        });
      } catch (err) {
        threw = true;
        assert.ok(err.message.includes("AGY authentication required"));
      }

      assert.ok(threw);
      assert.strictEqual(spawns.length, 1, "Must not retry on auth failure");
    });

    await testCase("Scenario 5: Non-retryable network error (TLS handshake timeout) -> does NOT retry", async () => {
      const spawns = [];
      spawnHandler = (command, args) => {
        spawns.push({ command, args });
        return createMockChild({
          events: [],
          stderr: 'Eligibility check failed: net/http: TLS handshake timeout',
          exitCode: 1,
        });
      };

      const opsDir = path.join(tmpBase, "s5-ops");
      const sessionsFile = path.join(tmpBase, "s5-sessions.json");
      const adapter = createAntigravityRuntimeAdapter({
        antigravityCommand: "mock-agy-retry",
        antigravityStreamRetryDelayMs: 10,
        opsDir,
        sessionsFile,
      });

      let threw = false;
      try {
        await adapter.sendTurn({
          bindingKey: "user-5",
          workspaceRoot: "d:\\workspace-retry-5",
          text: "TLS test",
        });
      } catch (err) {
        threw = true;
        assert.ok(err.message.includes("TLS handshake timeout"));
      }

      assert.ok(threw);
      assert.strictEqual(spawns.length, 1, "Must not retry on TLS handshake timeout");
    });

    await testCase("Scenario 6: Turn cancellation during retry delay aborts attempt 2", async () => {
      const spawns = [];
      spawnHandler = (command, args) => {
        spawns.push({ command, args });
        return createMockChild({
          events: [
            { event: "init", conversation_id: "conv-s6" },
            {
              event: "result",
              result: {
                conversation_id: "conv-s6",
                status: "ERROR",
                error: "The stream was interrupted.",
              },
            },
          ],
          exitCode: 1,
        });
      };

      const opsDir = path.join(tmpBase, "s6-ops");
      const sessionsFile = path.join(tmpBase, "s6-sessions.json");
      const adapter = createAntigravityRuntimeAdapter({
        antigravityCommand: "mock-agy-retry",
        antigravityStreamRetryDelayMs: 100, // longer delay
        antigravityStreamRetryMax: 1,
        opsDir,
        sessionsFile,
      });

      const turnPromise = adapter.sendTurn({
        bindingKey: "user-6",
        workspaceRoot: "d:\\workspace-retry-6",
        text: "Will be cancelled during delay",
      });

      // Cancel turn during retry delay
      await new Promise((r) => setTimeout(r, 20));
      await adapter.cancelTurn({ workspaceRoot: "d:\\workspace-retry-6" });

      let threw = false;
      try {
        await turnPromise;
      } catch (err) {
        threw = true;
      }

      assert.ok(threw);
      assert.strictEqual(spawns.length, 1, "Must not spawn attempt 2 if cancelled during delay");
    });

    await testCase("Scenario 7: Custom antigravityStreamRetryMax=0 disables retry completely", async () => {
      const spawns = [];
      spawnHandler = (command, args) => {
        spawns.push({ command, args });
        return createMockChild({
          events: [
            {
              event: "result",
              result: {
                status: "ERROR",
                error: "The stream was interrupted. Please continue the task you were working on.",
              },
            },
          ],
          exitCode: 1,
        });
      };

      const opsDir = path.join(tmpBase, "s7-ops");
      const sessionsFile = path.join(tmpBase, "s7-sessions.json");
      const adapter = createAntigravityRuntimeAdapter({
        antigravityCommand: "mock-agy-retry",
        antigravityStreamRetryMax: 0,
        opsDir,
        sessionsFile,
      });

      let threw = false;
      try {
        await adapter.sendTurn({
          bindingKey: "user-7",
          workspaceRoot: "d:\\workspace-retry-7",
          text: "No retry test",
        });
      } catch (err) {
        threw = true;
      }

      assert.ok(threw);
      assert.strictEqual(spawns.length, 1, "Must not retry when retryMax is 0");
    });
  } finally {
    spawnHandler = null;
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
