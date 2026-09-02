const assert = require("assert");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");
const { AntigravityProcessClient } = require("../src/adapters/runtime/antigravity/process-client");

const REAL_COMMAND = process.env.CYBERBOSS_ANTIGRAVITY_COMMAND || "antigravity";

function buildFakeCliExe() {
  const uid = Date.now() + '-' + process.pid;
  const tmpExe = path.join(os.tmpdir(), 'fake-antigravity-' + uid + '.exe');
  const tmpCs = path.join(os.tmpdir(), 'fake-antigravity-' + uid + '.cs');

  const csSource = [
    'using System;',
    'using System.Threading;',
    'class Program {',
    '    static void Main(string[] args) {',
    '        string mode = Environment.GetEnvironmentVariable("FAKE_MODE") ?? "ok";',
    '        if (mode == "malformed") {',
    '            Console.WriteLine("NOT_JSON_STREAM");',
    '            Thread.Sleep(10000);',
    '        } else if (mode == "init_mismatch") {',
    '            Console.WriteLine("{\\"event\\":\\"init\\",\\"conversation_id\\":\\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\\"}");',
    '            Thread.Sleep(10000);',
    '        } else if (mode == "result_mismatch") {',
    '            Console.WriteLine("{\\"event\\":\\"init\\",\\"conversation_id\\":\\"11111111-1111-1111-1111-111111111111\\"}");',
    '            Console.WriteLine("{\\"event\\":\\"result\\",\\"result\\":{\\"conversation_id\\":\\"22222222-2222-2222-2222-222222222222\\",\\"status\\":\\"SUCCESS\\",\\"response\\":\\"OK\\"}}");',
    '        } else if (mode == "ok") {',
    '            Console.WriteLine("{\\"event\\":\\"init\\",\\"conversation_id\\":\\"11111111-1111-1111-1111-111111111111\\"}");',
    '            Console.WriteLine("{\\"event\\":\\"result\\",\\"result\\":{\\"conversation_id\\":\\"11111111-1111-1111-1111-111111111111\\",\\"status\\":\\"SUCCESS\\",\\"response\\":\\"RECOVERED\\"}}");',
    '        }',
    '    }',
    '}'
  ].join('\n');

  fs.writeFileSync(tmpCs, csSource, "utf-8");
  const cscPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
  execSync(`"${cscPath}" /nologo /out:"${tmpExe}" "${tmpCs}"`, { stdio: "ignore" });

  try {
    fs.unlinkSync(tmpCs);
  } catch {
    // ignore
  }

  return {
    exePath: tmpExe,
    cleanup: () => {
      try {
        fs.unlinkSync(tmpExe);
      } catch {
        // ignore
      }
    },
  };
}

async function runTests() {
  console.log("==================================================");
  console.log("Running Part 1: Real Antigravity CLI Integration");
  console.log("==================================================");
  console.log(`Using antigravity command: ${REAL_COMMAND}`);

  const client = new AntigravityProcessClient({
    command: REAL_COMMAND,
    timeoutMs: 60_000,
  });

  const rawEvents = [];
  const unsubscribe = client.onMessage((evt) => {
    rawEvents.push(evt);
  });

  // --------------------------------
  // Test 1: New Conversation
  // --------------------------------
  console.log("Starting Test 1: New conversation...");
  const turn1 = await client.runTurn({
    text: "记住测试字符串 AGY_CLIENT_4826，只回复 AGY_STAGE1_OK。",
  });

  console.log("Turn 1 result:", JSON.stringify(turn1, null, 2));

  assert.strictEqual(turn1.status, "SUCCESS", "Test 1 status must be SUCCESS");
  assert(turn1.response.includes("AGY_STAGE1_OK"), `Test 1 response must contain AGY_STAGE1_OK, got: ${turn1.response}`);
  assert(turn1.conversationId, "Test 1 conversationId must not be empty");
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(turn1.conversationId),
    `Test 1 conversationId must match UUID format, got: ${turn1.conversationId}`
  );

  const eventTypes = rawEvents.map((e) => e.event);
  assert(eventTypes.includes("init"), "onMessage must receive init event");
  assert(eventTypes.includes("result"), "onMessage must receive result event");

  console.log("TEST1 PASS");
  console.log(`conversationId=${turn1.conversationId}`);

  // --------------------------------
  // Test 2: Resume Conversation
  // --------------------------------
  console.log("\nStarting Test 2: Resume conversation with conversationId...");
  const turn2 = await client.runTurn({
    conversationId: turn1.conversationId,
    text: "我上一轮让你记住的测试字符串是什么？只回复那个字符串。",
  });

  console.log("Turn 2 result:", JSON.stringify(turn2, null, 2));

  assert.strictEqual(turn2.status, "SUCCESS", "Test 2 status must be SUCCESS");
  assert(turn2.response.includes("AGY_CLIENT_4826"), `Test 2 response must contain AGY_CLIENT_4826, got: ${turn2.response}`);
  assert.strictEqual(turn2.conversationId, turn1.conversationId, "Test 2 conversationId must match Test 1 exactly");

  console.log("TEST2 PASS");
  console.log(`response=${turn2.response.trim()}`);

  unsubscribe();
  await client.close();

  // ==================================================
  // Part 2: Fake Process Boundary Hardening Tests
  // ==================================================
  console.log("\n==================================================");
  console.log("Running Part 2: Boundary Hardening & Exception Tests");
  console.log("==================================================");

  const fake = buildFakeCliExe();
  try {
    // Case A: Malformed JSON output
    console.log("Testing Case A: Malformed JSON output & process abort...");
    const malformedClient = new AntigravityProcessClient({
      command: fake.exePath,
      env: { ...process.env, FAKE_MODE: "malformed" },
      timeoutMs: 5000,
    });

    let malformedCaught = false;
    try {
      await malformedClient.runTurn({ text: "test malformed" });
    } catch (err) {
      malformedCaught = true;
      assert(
        err.message.includes("Failed to parse antigravity stream-json output"),
        `Expected parse error, got: ${err.message}`
      );
    }
    assert(malformedCaught, "runTurn must reject on malformed JSON");
    assert.strictEqual(malformedClient.running, false, "running must reset to false after abort");
    assert.strictEqual(malformedClient.child, null, "child reference must be null after abort");

    // Immediately run a valid turn to verify not locked with "already running"
    console.log("Verifying immediate subsequent turn after malformed abort...");
    const recoveryClient = new AntigravityProcessClient({
      command: fake.exePath,
      env: { ...process.env, FAKE_MODE: "ok" },
    });
    const recoveryTurn = await recoveryClient.runTurn({ text: "test recover" });
    assert.strictEqual(recoveryTurn.status, "SUCCESS");
    assert.strictEqual(recoveryTurn.response, "RECOVERED");
    console.log("CASE A PASS");

    // Case B: Conversation ID mismatch on init
    console.log("\nTesting Case B: Conversation ID mismatch on init...");
    const mismatchClient = new AntigravityProcessClient({
      command: fake.exePath,
      env: { ...process.env, FAKE_MODE: "init_mismatch" },
      timeoutMs: 5000,
    });

    let mismatchCaught = false;
    try {
      await mismatchClient.runTurn({
        text: "test mismatch",
        conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      });
    } catch (err) {
      mismatchCaught = true;
      assert(
        err.message.includes("expected conversation bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
        `Expected mismatch error, got: ${err.message}`
      );
    }
    assert(mismatchCaught, "runTurn must reject on conversation mismatch");
    assert.strictEqual(mismatchClient.running, false, "running must reset to false");
    assert.strictEqual(mismatchClient.child, null, "child must be null");
    console.log("CASE B PASS");

    // Case C: Conversation ID mismatch on result
    console.log("\nTesting Case C: Conversation ID mismatch on result event...");
    const resultMismatchClient = new AntigravityProcessClient({
      command: fake.exePath,
      env: { ...process.env, FAKE_MODE: "result_mismatch" },
    });

    let resultMismatchCaught = false;
    try {
      await resultMismatchClient.runTurn({ text: "test result mismatch" });
    } catch (err) {
      resultMismatchCaught = true;
      assert(
        err.message.includes(
          "antigravity conversation changed from 11111111-1111-1111-1111-111111111111 to 22222222-2222-2222-2222-222222222222"
        ),
        `Expected changed error, got: ${err.message}`
      );
    }
    assert(resultMismatchCaught, "runTurn must reject when result conversation_id mutates");
    assert.strictEqual(resultMismatchClient.running, false);
    assert.strictEqual(resultMismatchClient.child, null);
    console.log("CASE C PASS");

    console.log("\n==================================================");
    console.log("ALL STAGE 1.1 HARDENING & REAL TESTS PASSED 100%!");
    console.log("==================================================");
  } finally {
    fake.cleanup();
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
