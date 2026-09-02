const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { mapAntigravityMessageToRuntimeEvents } = require("../src/adapters/runtime/antigravity/events");
const { createAntigravityRuntimeAdapter } = require("../src/adapters/runtime/antigravity");

const REAL_COMMAND = process.env.CYBERBOSS_ANTIGRAVITY_COMMAND || "antigravity";

async function runSyntheticEventTests() {
  console.log("==================================================");
  console.log("Part 1: Synthetic Events Unit Tests");
  console.log("==================================================");

  // A. init event mapping
  console.log("Testing Synthetic A: init event mapping...");
  const initEvents = mapAntigravityMessageToRuntimeEvents(
    { event: "init", conversation_id: "test-uuid-1234" },
    { turnId: "turn-001" }
  );
  assert.strictEqual(initEvents.length, 1);
  assert.strictEqual(initEvents[0].type, "runtime.turn.started");
  assert.strictEqual(initEvents[0].payload.threadId, "test-uuid-1234");
  assert.strictEqual(initEvents[0].payload.turnId, "turn-001");
  console.log("SYNTHETIC_TEST_A_PASS");

  // B. result event mapping (SUCCESS)
  console.log("Testing Synthetic B: result event mapping (SUCCESS)...");
  const successEvents = mapAntigravityMessageToRuntimeEvents(
    {
      event: "result",
      result: {
        conversation_id: "test-uuid-1234",
        status: "SUCCESS",
        response: "Hello world reply",
        usage: {
          input_tokens: 100,
          cache_read_tokens: 20,
          output_tokens: 50,
          thinking_tokens: 30,
          total_tokens: 150,
        },
      },
    },
    { turnId: "turn-001" }
  );
  assert.strictEqual(successEvents.length, 3);
  assert.strictEqual(successEvents[0].type, "runtime.context.updated");
  assert.strictEqual(successEvents[0].payload.inputTokens, 100);
  assert.strictEqual(successEvents[0].payload.cacheReadInputTokens, 20);
  assert.strictEqual(successEvents[0].payload.outputTokens, 50);
  assert.strictEqual(successEvents[0].payload.reasoningTokens, 30);
  assert.strictEqual(successEvents[0].payload.currentTokens, 150);

  assert.strictEqual(successEvents[1].type, "runtime.reply.completed");
  assert.strictEqual(successEvents[1].payload.text, "Hello world reply");
  assert.strictEqual(successEvents[1].payload.itemId, "agy-result-turn-001");

  assert.strictEqual(successEvents[2].type, "runtime.turn.completed");
  assert.strictEqual(successEvents[2].payload.text, "Hello world reply");
  console.log("SYNTHETIC_TEST_B_PASS");

  // C. result event mapping (ERROR)
  console.log("Testing Synthetic C: result event mapping (ERROR)...");
  const failedEvents = mapAntigravityMessageToRuntimeEvents(
    {
      event: "result",
      result: {
        conversation_id: "test-uuid-1234",
        status: "ERROR",
        error: "Engine crashed",
      },
    },
    { turnId: "turn-001" }
  );
  assert.strictEqual(failedEvents.length, 1);
  assert.strictEqual(failedEvents[0].type, "runtime.turn.failed");
  assert.strictEqual(failedEvents[0].payload.text, "Engine crashed");
  assert(!failedEvents.some((e) => e.type === "runtime.turn.completed"));
  console.log("SYNTHETIC_TEST_C_PASS");

  // D. step_update ignored
  console.log("Testing Synthetic D: step_update ignored...");
  const stepEvents = mapAntigravityMessageToRuntimeEvents(
    {
      event: "step_update",
      step_update: { step_type: "agent_response", text_delta: "streaming delta..." },
    },
    { turnId: "turn-001" }
  );
  assert.deepStrictEqual(stepEvents, []);
  console.log("SYNTHETIC_TEST_D_PASS");
}

async function runRealRuntimeAdapterTests() {
  console.log("\n==================================================");
  console.log("Part 2: Real Runtime Adapter Integration Tests");
  console.log("==================================================");

  const tmpBase = path.join(os.tmpdir(), `cyberboss-agy-runtime-${Date.now()}`);
  fs.mkdirSync(tmpBase, { recursive: true });

  const tempSessionsFile = path.join(tmpBase, "sessions.json");
  const tempWorkspaceRoot = path.join(tmpBase, "workspace");
  fs.mkdirSync(tempWorkspaceRoot, { recursive: true });

  const config = {
    sessionsFile: tempSessionsFile,
    antigravityCommand: REAL_COMMAND,
    antigravityTimeoutMs: 60_000,
    antigravityModel: "",
    antigravityEffort: "",
    antigravityExtraArgs: [],
    weixinInstructionsFile: "",
    weixinOperationsFile: "",
  };

  const runtime = createAntigravityRuntimeAdapter(config);

  try {
    assert.strictEqual(runtime.describe().id, "antigravity");
    const caps = runtime.getTurnCapabilities();
    assert.strictEqual(caps.nativeImageInput, false);
    assert.strictEqual(caps.toolImageRead, true);

    const readyState = await runtime.initialize();
    assert(readyState && readyState.command);

    const sessionStore = runtime.getSessionStore();
    const bindingKey = sessionStore.buildBindingKey({
      workspaceId: "stage2",
      accountId: "stage2",
      senderId: "stage2",
    });

    const recordedEvents = [];
    const unsubscribe = runtime.onEvent((evt) => {
      recordedEvents.push(evt);
    });

    // --------------------------------
    // Real Test 1: New Conversation
    // --------------------------------
    console.log("Starting Real Test 1: New conversation...");
    const turn1Result = await runtime.sendTurn({
      bindingKey,
      workspaceRoot: tempWorkspaceRoot,
      text: "记住测试字符串 AGY_RUNTIME_5934，只回复 AGY_RUNTIME_STAGE2_OK。",
      metadata: {
        workspaceId: "stage2",
        accountId: "stage2",
        senderId: "stage2",
      },
    });

    console.log("Turn 1 Result:", JSON.stringify(turn1Result, null, 2));

    assert(turn1Result.threadId, "Turn 1 must return a valid threadId");
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(turn1Result.threadId),
      `Turn 1 threadId must be UUID, got: ${turn1Result.threadId}`
    );
    assert(turn1Result.turnId, "Turn 1 must return a turnId");

    const storedThreadId = sessionStore.getThreadIdForWorkspace(bindingKey, tempWorkspaceRoot);
    assert.strictEqual(storedThreadId, turn1Result.threadId, "SessionStore must record threadId");

    // Check events emitted for turn 1
    const turn1Events = recordedEvents.filter((e) => e.payload.turnId === turn1Result.turnId);
    const turn1EventTypes = turn1Events.map((e) => e.type);

    assert(turn1EventTypes.includes("runtime.turn.started"), "Must emit runtime.turn.started");
    assert(turn1EventTypes.includes("runtime.reply.completed"), "Must emit runtime.reply.completed");
    assert(turn1EventTypes.includes("runtime.turn.completed"), "Must emit runtime.turn.completed");
    assert(turn1EventTypes.includes("runtime.context.updated"), "Must emit runtime.context.updated");

    const replyEvent = turn1Events.find((e) => e.type === "runtime.reply.completed");
    assert(
      replyEvent.payload.text.includes("AGY_RUNTIME_STAGE2_OK"),
      `Reply text must contain AGY_RUNTIME_STAGE2_OK, got: ${replyEvent.payload.text}`
    );

    console.log("RUNTIME_TEST1_PASS");
    console.log(`threadId=${turn1Result.threadId}`);
    console.log(`turnId=${turn1Result.turnId}`);

    // --------------------------------
    // Real Test 2: Auto Resume via SessionStore
    // --------------------------------
    console.log("\nStarting Real Test 2: Resume conversation via SessionStore lookup...");
    const turn2Result = await runtime.sendTurn({
      bindingKey,
      workspaceRoot: tempWorkspaceRoot,
      text: "我上一轮让你记住的测试字符串是什么？只回复那个字符串。",
      metadata: {
        workspaceId: "stage2",
        accountId: "stage2",
        senderId: "stage2",
      },
    });

    console.log("Turn 2 Result:", JSON.stringify(turn2Result, null, 2));

    assert.strictEqual(
      turn2Result.threadId,
      turn1Result.threadId,
      "Turn 2 threadId must match Turn 1 threadId exactly"
    );
    assert.notStrictEqual(turn2Result.turnId, turn1Result.turnId, "Turn 2 must have a new distinct turnId");

    const turn2Events = recordedEvents.filter((e) => e.payload.turnId === turn2Result.turnId);
    const reply2Event = turn2Events.find((e) => e.type === "runtime.reply.completed");
    assert(reply2Event, "Turn 2 must emit runtime.reply.completed");
    assert(
      reply2Event.payload.text.includes("AGY_RUNTIME_5934"),
      `Reply 2 must contain AGY_RUNTIME_5934, got: ${reply2Event.payload.text}`
    );

    console.log("RUNTIME_TEST2_PASS");
    console.log(`response=${reply2Event.payload.text.trim()}`);

    unsubscribe();
    await runtime.close();

    console.log("\n==================================================");
    console.log("ALL STAGE 2 RUNTIME ADAPTER TESTS PASSED 100%!");
    console.log("==================================================");
  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

async function main() {
  await runSyntheticEventTests();
  await runRealRuntimeAdapterTests();
}

main().catch((err) => {
  console.error("Stage 2 tests failed:", err);
  process.exit(1);
});
