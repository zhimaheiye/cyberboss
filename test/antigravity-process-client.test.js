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
  await testCase("isSuccessfulResultEvent returns true for valid SUCCESS, DONE, COMPLETED (case-insensitive)", async () => {
    assert.strictEqual(isSuccessfulResultEvent({ status: "SUCCESS" }, "conv-123"), true);
    assert.strictEqual(isSuccessfulResultEvent({ status: "success" }, "conv-123"), true);
    assert.strictEqual(isSuccessfulResultEvent({ status: "DONE" }, "conv-123"), true);
    assert.strictEqual(isSuccessfulResultEvent({ status: "done" }, "conv-123"), true);
    assert.strictEqual(isSuccessfulResultEvent({ status: "COMPLETED" }, "conv-123"), true);
    assert.strictEqual(isSuccessfulResultEvent({ status: "completed" }, "conv-123"), true);
  });

  await testCase("isSuccessfulResultEvent returns true when status is missing/undefined/empty but response is present", async () => {
    assert.strictEqual(isSuccessfulResultEvent({ response: "{\"action\":\"silent\"}" }, "conv-123"), true);
    assert.strictEqual(isSuccessfulResultEvent({ response: "" }, "conv-123"), true);
    assert.strictEqual(isSuccessfulResultEvent({ status: "", response: "hello" }, "conv-123"), true);
    assert.strictEqual(isSuccessfulResultEvent({ status: "   ", response: "hello" }, "conv-123"), true);
    assert.strictEqual(isSuccessfulResultEvent({ status: null, response: "hello" }, "conv-123"), true);
    assert.strictEqual(isSuccessfulResultEvent({ status: undefined, response: "hello" }, "conv-123"), true);
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
    assert.strictEqual(isSuccessfulResultEvent({ response: "ok" }, ""), false);
  });

  await testCase("isSuccessfulResultEvent returns false for explicit failure status even if response is present", async () => {
    assert.strictEqual(isSuccessfulResultEvent({ status: "FAILED", response: "ok" }, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent({ status: "failed", response: "ok" }, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent({ status: "ERROR", response: "ok" }, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent({ status: "FAILURE", response: "ok" }, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent({ status: "CANCELLED", response: "ok" }, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent({ status: "CANCELED", response: "ok" }, "conv-123"), false);
  });

  await testCase("isSuccessfulResultEvent returns false if result has explicit error indicating failure", async () => {
    assert.strictEqual(isSuccessfulResultEvent({ error: "turn failed" }, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent({ status: "SUCCESS", error: "fatal error" }, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent({ response: "hello", error: { message: "quota exceeded" } }, "conv-123"), false);
  });

  await testCase("isSuccessfulResultEvent returns false for unknown non-empty status", async () => {
    assert.strictEqual(isSuccessfulResultEvent({ status: "WEIRD_STATE", response: "ok" }, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent({ status: "UNKNOWN", response: "ok" }, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent({ status: "RUNNING", response: "ok" }, "conv-123"), false);
  });

  await testCase("isSuccessfulResultEvent returns false when status is missing AND response is undefined", async () => {
    assert.strictEqual(isSuccessfulResultEvent({}, "conv-123"), false);
    assert.strictEqual(isSuccessfulResultEvent({ num_turns: 1 }, "conv-123"), false);
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
  await testCase("Scenario 1: SUCCESS + response + exit 0 -> resolves normally", async () => {
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
  await testCase("Scenario 2: SUCCESS + response + teardown exit 1 -> resolves with exitCode=1", async () => {
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

  // Scenario 3: status missing + valid response + conversationId + exit 0
  await testCase("Scenario 3: status missing + valid response + conversationId + exit 0 -> resolves normally", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "status_missing_exit_0" },
      timeoutMs: 10_000,
    });

    const result = await client.runTurn({
      text: "hello scenario 3",
    });

    assert.strictEqual(result.conversationId, "conv-123");
    assert.strictEqual(result.status, "SUCCESS");
    assert.strictEqual(result.response, "{\"action\":\"silent\"}");
    assert.strictEqual(result.exitCode, 0);
  });

  // Scenario 4: status missing + valid response + teardown exit 1
  await testCase("Scenario 4: status missing + valid response + teardown exit 1 -> resolves with exitCode=1", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "status_missing_exit_1" },
      timeoutMs: 10_000,
    });

    const result = await client.runTurn({
      text: "hello scenario 4",
    });

    assert.strictEqual(result.conversationId, "conv-123");
    assert.strictEqual(result.status, "SUCCESS");
    assert.strictEqual(result.response, "{\"action\":\"send_message\",\"message\":\"醒啦？今天这一觉睡得挺沉\"}");
    assert.strictEqual(result.exitCode, 1);
  });

  // Scenario 5: Other confirmed success statuses: DONE and COMPLETED
  await testCase("Scenario 5a: status DONE + exit 0 -> resolves normally", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "status_done_exit_0" },
      timeoutMs: 10_000,
    });

    const result = await client.runTurn({ text: "hello scenario 5a" });
    assert.strictEqual(result.conversationId, "conv-123");
    assert.strictEqual(result.status, "DONE");
    assert.strictEqual(result.response, "done status result");
    assert.strictEqual(result.exitCode, 0);
  });

  await testCase("Scenario 5b: status COMPLETED + exit 0 -> resolves normally", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "status_completed_exit_0" },
      timeoutMs: 10_000,
    });

    const result = await client.runTurn({ text: "hello scenario 5b" });
    assert.strictEqual(result.conversationId, "conv-123");
    assert.strictEqual(result.status, "COMPLETED");
    assert.strictEqual(result.response, "completed status result");
    assert.strictEqual(result.exitCode, 0);
  });

  // Scenario 6: FAILED + response (must NOT treat response text as error message)
  await testCase("Scenario 6a: FAILED status with response -> rejects without using response as error message", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "failed_result_exit_0" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({ text: "hello scenario 6a" });
      },
      (err) => {
        assert(err instanceof Error);
        assert.strictEqual(err.message, 'antigravity turn failed with status FAILED: unknown error');
        assert(!err.message.includes('{"action":"silent"}'));
        return true;
      }
    );
  });

  await testCase("Scenario 6b: FAILED status with error detail + exit 1 -> rejects with formatted error", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "failed_result_exit_1" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({ text: "hello scenario 6b" });
      },
      (err) => {
        assert(err instanceof Error);
        assert.strictEqual(
          err.message,
          "antigravity turn failed with status FAILED: model quota exceeded or turn failed"
        );
        return true;
      }
    );
  });

  // Scenario 7: ERROR + error + exit 1
  await testCase("Scenario 7: ERROR status with error detail + exit 1 -> rejects with formatted error", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "error_result_exit_1" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({ text: "hello scenario 7" });
      },
      (err) => {
        assert(err instanceof Error);
        assert.strictEqual(
          err.message,
          "antigravity turn failed with status ERROR: internal language server error"
        );
        return true;
      }
    );
  });

  // Scenario 8: Unknown non-empty status: WEIRD_STATE
  await testCase("Scenario 8: unknown non-empty status WEIRD_STATE -> rejects without swallowing", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "unsupported_status_weird" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({ text: "hello scenario 8" });
      },
      (err) => {
        assert(err instanceof Error);
        assert.strictEqual(err.message, 'antigravity returned unsupported result status "WEIRD_STATE"');
        return true;
      }
    );
  });

  // Scenario 9: No result + exit 0
  await testCase("Scenario 9: no result + exit 0 -> must reject", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "no_result_exit_0" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({ text: "hello scenario 9" });
      },
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("antigravity process exited without emitting a result event"));
        return true;
      }
    );
  });

  // Scenario 10: No result + exit 1
  await testCase("Scenario 10: no result + exit 1 -> must reject with code 1", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "no_result_exit_1" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({ text: "hello scenario 10" });
      },
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("antigravity exited with code 1"));
        return true;
      }
    );
  });

  // Scenario 11: Conversation mismatch
  await testCase("Scenario 11: conversation ID mismatch -> must reject", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "conversation_mismatch" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({
          text: "hello scenario 11",
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

  // Scenario 12: Malformed stdout
  await testCase("Scenario 12: malformed stdout + exit 1 -> must reject", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "malformed_stdout" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({ text: "hello scenario 12" });
      },
      (err) => {
        assert(err instanceof Error);
        assert(err.message.includes("Failed to parse antigravity stream-json output"));
        return true;
      }
    );
  });

  // Scenario 13: Blocked persistent tool
  await testCase("Scenario 13: blocked persistent tool -> must reject and not be overwritten by result", async () => {
    const client = new AntigravityProcessClient({
      command: "mock-agy-process",
      env: { ...process.env, TEST_SCENARIO: "blocked_tool" },
      timeoutMs: 10_000,
    });

    await assert.rejects(
      async () => {
        await client.runTurn({ text: "hello scenario 13" });
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
