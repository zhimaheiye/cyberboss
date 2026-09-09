const cp = require("child_process");
const path = require("path");
const assert = require("assert");

const originalSpawn = cp.spawn;
const mockScriptPath = path.join(__dirname, "mock-scenario-cli.js");

cp.spawn = function (command, args, options) {
  if (command === "mock-agy-process") {
    return originalSpawn(process.execPath, [mockScriptPath, ...args], options);
  }
  return originalSpawn(command, args, options);
};

const {
  AntigravityProcessClient,
  isSuccessfulResultEvent,
  summarizeStderr,
} = require("../src/adapters/runtime/antigravity/process-client");

async function runAllTests() {
  console.log("Running AntigravityProcessClient deterministic regression test suite...\n");
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

  // Unit tests: isSuccessfulResultEvent
  await testCase("isSuccessfulResultEvent returns true for valid SUCCESS result", async () => {
    assert.strictEqual(
      isSuccessfulResultEvent({ status: "SUCCESS" }, "conv-123"),
      true
    );
  });

  await testCase("isSuccessfulResultEvent returns false for missing or non-object result", async () => {
    assert.strictEqual(isSuccessfulResultEvent(null, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent(undefined, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent("SUCCESS", "conv-123"), false);
  });

  await testCase("isSuccessfulResultEvent returns false for missing or empty conversationId", async () => {
    assert.strictEqual(isSuccessfulResultEvent({ status: "SUCCESS" }, ""), false);
    assert.strictEqual(isSuccessfulResultEvent({ status: "SUCCESS" }, "   "), false);
    assert.strictEqual(isSuccessfulResultEvent({ status: "SUCCESS" }, null), false);
  });

  await testCase("isSuccessfulResultEvent returns false for non-SUCCESS status", async () => {
    assert.strictEqual(isSuccessfulResultEvent({ status: "FAILED" }, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent({ status: "ERROR" }, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent({ status: "UNKNOWN" }, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent({}, "conv-123"), false);
  });

  // Unit tests: summarizeStderr
  await testCase("summarizeStderr formats single-line, truncates, and redacts sensitive data", async () => {
    assert.strictEqual(summarizeStderr(""), "");
    assert.strictEqual(summarizeStderr("   "), "");
    assert.strictEqual(
      summarizeStderr("line1\nline2\r\nline3"),
      "line1 | line2 | line3"
    );
    const longText = "a".repeat(300);
    const summary = summarizeStderr(longText, 100);
    assert.strictEqual(summary.length, 103);
    assert(summary.endsWith("..."));

    const sensitive = "error with Bearer secret-token-value-123 here";
    assert.strictEqual(
      summarizeStderr(sensitive),
      "error with Bearer <redacted> here"
    );
  });

  // Scenario 1: init + SUCCESS result + exit 0
  await testCase("Scenario 1: init + SUCCESS result + exit 0 -> resolves normally", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "success_exit_0" },
      timeoutMs: 10_000,
    });

    const result = await client.runTurn({
      text: "hello scenario 1",
    });

    assert.strictEqual(result.conversationId, "conv-123");
    assert.strictEqual(result.status, "SUCCESS");
    assert.strictEqual(result.response, "scenario 1 success response");
    assert.strictEqual(result.exitCode, 0);
  });

  // Scenario 2: init + SUCCESS result + stderr teardown error + exit 1
  await testCase("Scenario 2: init + SUCCESS result + stderr teardown error + exit 1 -> resolves with exitCode=1", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "success_exit_1" },
      timeoutMs: 10_000,
    });

    const result = await client.runTurn({
      text: "hello scenario 2",
    });

    assert.strictEqual(result.conversationId, "conv-123");
    assert.strictEqual(result.status, "SUCCESS");
    assert.strictEqual(result.response, "scenario 2 success response despite exit 1");
    assert.strictEqual(result.exitCode, 1);
  });

  // Scenario 3: init 后无 result + exit 1
  await testCase("Scenario 3: init without result + exit 1 -> must reject", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "no_result_exit_1" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({ text: "hello scenario 3" });
      },
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("exit code 1") || err.message.includes("crashed before emitting result"));
        return true;
      }
    );
  });

  // Scenario 4: init + 明确 FAILED/non-success result + exit 1
  await testCase("Scenario 4: init + explicit FAILED result + exit 1 -> must reject", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "failed_result_exit_1" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({ text: "hello scenario 4" });
      },
      (err) => {
        assert(err instanceof Error);
        return true;
      }
    );
  });

  // Scenario 5: malformed stdout + exit 1
  await testCase("Scenario 5: malformed stdout + exit 1 -> must reject", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "malformed_stdout" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({ text: "hello scenario 5" });
      },
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("Failed to parse antigravity stream-json output"));
        return true;
      }
    );
  });

  // Scenario 6: conversation ID mismatch
  await testCase("Scenario 6: conversation ID mismatch -> must reject", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "conversation_mismatch" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({
          text: "hello scenario 6",
          conversationId: "conv-expected-111",
        });
      },
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("expected conversation conv-expected-111 but antigravity reported conv-unexpected-999"));
        return true;
      }
    );
  });

  // Scenario 7: blocked persistent tool
  await testCase("Scenario 7: blocked persistent tool -> must reject and not be overwritten by result", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "blocked_tool" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({ text: "hello scenario 7" });
      },
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("antigravity attempted unsupported persistent tool: schedule"));
        return true;
      }
    );
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
