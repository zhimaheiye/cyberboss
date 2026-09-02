const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const {
  extractBlockedPersistentTool,
  BLOCKED_PERSISTENT_TOOLS,
} = require("../src/adapters/runtime/antigravity/events");
const {
  AntigravityProcessClient,
} = require("../src/adapters/runtime/antigravity/process-client");
const {
  createAntigravityRuntimeAdapter,
} = require("../src/adapters/runtime/antigravity/index");

console.log("==================================================");
console.log("Running Stage 6.6: Headless Persistent-Tool Guard");
console.log("==================================================");

// Helper to build a native test binary using Windows built-in csc.exe
function buildFakeCliExe() {
  const uid = Date.now() + "-" + process.pid;
  const tmpExe = path.join(os.tmpdir(), "fake-guard-" + uid + ".exe");
  const tmpCs = path.join(os.tmpdir(), "fake-guard-" + uid + ".cs");

  const csSource = [
    "using System;",
    "using System.Threading;",
    "class Program {",
    "    static void Main(string[] args) {",
    '        string mode = Environment.GetEnvironmentVariable("FAKE_GUARD_MODE") ?? "schedule";',
    '        if (mode == "schedule") {',
    '            Console.WriteLine("{\\"event\\":\\"init\\",\\"conversation_id\\":\\"11111111-1111-1111-1111-111111111111\\"}");',
    '            Console.WriteLine("{\\"event\\":\\"step_update\\",\\"step_update\\":{\\"step_type\\":\\"tool\\",\\"tool_name\\":\\"schedule\\",\\"tool_input\\":{\\"DurationSeconds\\":12600},\\"state\\":\\"ACTIVE\\"}}");',
    "            Thread.Sleep(60000);",
    '        } else if (mode == "manage_task") {',
    '            Console.WriteLine("{\\"event\\":\\"init\\",\\"conversation_id\\":\\"11111111-1111-1111-1111-111111111111\\"}");',
    '            Console.WriteLine("{\\"event\\":\\"step_update\\",\\"step_update\\":{\\"step_type\\":\\"tool\\",\\"tool_name\\":\\"manage_task\\",\\"state\\":\\"ACTIVE\\"}}");',
    "            Thread.Sleep(60000);",
    '        } else if (mode == "ok") {',
    '            Console.WriteLine("{\\"event\\":\\"init\\",\\"conversation_id\\":\\"11111111-1111-1111-1111-111111111111\\"}");',
    '            Console.WriteLine("{\\"event\\":\\"result\\",\\"result\\":{\\"conversation_id\\":\\"11111111-1111-1111-1111-111111111111\\",\\"status\\":\\"SUCCESS\\",\\"response\\":\\"NORMAL_OK\\"}}");',
    "        }",
    "    }",
    "}",
  ].join("\n");

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

// --------------------------------------------------
// Part 1: Unit Tests for extractBlockedPersistentTool
// --------------------------------------------------
console.log("\n--- Part 1: extractBlockedPersistentTool Unit Tests ---");

assert(Array.isArray(BLOCKED_PERSISTENT_TOOLS), "BLOCKED_PERSISTENT_TOOLS must be an array");
assert(BLOCKED_PERSISTENT_TOOLS.includes("schedule"), "Must include schedule");
assert(BLOCKED_PERSISTENT_TOOLS.includes("manage_task"), "Must include manage_task");
assert(BLOCKED_PERSISTENT_TOOLS.includes("wait"), "Must include wait");
assert(BLOCKED_PERSISTENT_TOOLS.includes("sleep"), "Must include sleep");

// Direct tool_name
assert.strictEqual(
  extractBlockedPersistentTool({ event: "step_update", step_update: { tool_name: "schedule" } }),
  "schedule"
);
assert.strictEqual(
  extractBlockedPersistentTool({ event: "step_update", step_update: { tool_name: "SCHEDULE" } }),
  "schedule"
);
assert.strictEqual(
  extractBlockedPersistentTool({ event: "step_update", step_update: { tool_name: "manage_task" } }),
  "manage_task"
);
assert.strictEqual(
  extractBlockedPersistentTool({ event: "step_update", step_update: { tool_name: "wait" } }),
  "wait"
);
assert.strictEqual(
  extractBlockedPersistentTool({ event: "step_update", step_update: { tool_name: "sleep" } }),
  "sleep"
);

// MCP call wrapping
assert.strictEqual(
  extractBlockedPersistentTool({
    event: "step_update",
    step_update: {
      tool_name: "call_mcp_tool",
      tool_input: { ServerName: "custom", ToolName: "schedule" },
    },
  }),
  "call_mcp_tool(schedule)"
);

// Safe tools must return null
assert.strictEqual(
  extractBlockedPersistentTool({ event: "step_update", step_update: { tool_name: "view_file" } }),
  null
);
assert.strictEqual(
  extractBlockedPersistentTool({ event: "step_update", step_update: { tool_name: "write_to_file" } }),
  null
);
assert.strictEqual(
  extractBlockedPersistentTool({ event: "step_update", step_update: { tool_name: "list_dir" } }),
  null
);
assert.strictEqual(extractBlockedPersistentTool(null), null);
assert.strictEqual(extractBlockedPersistentTool({}), null);

console.log("EXTRACT_BLOCKED_TOOL_UNIT_PASS");

// --------------------------------------------------
// Part 2: ProcessClient Guard & Immediate Abort Test
// --------------------------------------------------
console.log("\n--- Part 2: ProcessClient Guard & Immediate Abort Test ---");

async function testProcessClientGuard(fake) {
  const client = new AntigravityProcessClient({
    command: fake.exePath,
    env: { ...process.env, FAKE_GUARD_MODE: "schedule" },
    timeoutMs: 30000,
  });

  const startTime = Date.now();
  let caughtErr = null;
  try {
    await client.runTurn({ text: "3.5小时后提醒我" });
  } catch (err) {
    caughtErr = err;
  }

  const durationMs = Date.now() - startTime;
  console.log(`ProcessClient rejection duration: ${durationMs}ms`);
  assert(caughtErr, "Turn must be rejected when schedule is attempted");
  assert(
    caughtErr.message.includes("antigravity attempted unsupported persistent tool: schedule"),
    `Error message must identify blocked tool: ${caughtErr.message}`
  );
  assert(
    durationMs < 5000,
    `Must abort immediately upon detecting schedule, did not wait for timeout: ${durationMs}ms`
  );

  console.log("PROCESS_CLIENT_GUARD_PASS");
  await client.close().catch(() => {});
}

// --------------------------------------------------
// Part 3: RuntimeAdapter Guard & Active-Run Lock Cleanup
// --------------------------------------------------
console.log("\n--- Part 3: RuntimeAdapter Guard & Lock Cleanup Test ---");

async function testRuntimeAdapterGuard(fake) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-runtime-guard-"));
  const sessionsFile = path.join(tempDir, "sessions.json");

  const config = {
    sessionsFile,
    antigravityCommand: fake.exePath,
    antigravityModel: "",
    antigravityEffort: "",
    antigravityTimeoutMs: 30000,
    antigravityExtraArgs: [],
    weixinInstructionsFile: "",
    weixinOperationsFile: "",
  };

  const adapter = createAntigravityRuntimeAdapter(config);
  const events = [];
  adapter.onEvent((evt) => events.push(evt));

  process.env.FAKE_GUARD_MODE = "schedule";
  let firstTurnFailed = false;
  try {
    await adapter.sendTurn({
      bindingKey: "test:binding:user1",
      workspaceRoot: tempDir,
      text: "提醒我一小时后喝水",
    });
  } catch (err) {
    firstTurnFailed = true;
  }

  assert(firstTurnFailed, "First turn must fail because schedule is blocked");

  // Verify runtime.turn.failed event was emitted
  const failedEvt = events.find((e) => e.type === "runtime.turn.failed");
  assert(failedEvt, "runtime.turn.failed event must be emitted");
  assert(
    failedEvt.payload.text.includes("unsupported persistent tool: schedule"),
    `Failed event text must state unsupported persistent tool: ${failedEvt.payload.text}`
  );

  // Verify same-scope lock was cleaned up: second normal turn should succeed without concurrency error!
  process.env.FAKE_GUARD_MODE = "ok";
  const secondTurnResult = await adapter.sendTurn({
    bindingKey: "test:binding:user1",
    workspaceRoot: tempDir,
    text: "你好",
  });

  assert(secondTurnResult, "Second turn must execute successfully without being blocked by activeRuns lock");
  assert.strictEqual(secondTurnResult.turnId.startsWith("agy-turn-"), true);
  console.log("RUNTIME_ADAPTER_LOCK_CLEANUP_PASS");

  await adapter.close();
  delete process.env.FAKE_GUARD_MODE;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// --------------------------------------------------
// Part 4: Prompt Template Prohibitions Verification
// --------------------------------------------------
console.log("\n--- Part 4: Prompt Template Prohibitions Verification ---");

const templatePath = path.resolve(__dirname, "..", "templates", "weixin-operations.md");
assert(fs.existsSync(templatePath), "templates/weixin-operations.md must exist");
const templateContent = fs.readFileSync(templatePath, "utf8");

assert(
  templateContent.includes("Never use Antigravity built-in schedule, manage_task, wait, sleep, timer"),
  "Template must forbid built-in schedule, manage_task, wait, sleep, timer"
);
assert(
  templateContent.includes("A user reminder is not a reason to keep the current turn open"),
  "Template must state user reminder is not a reason to keep current turn open"
);
assert(
  templateContent.includes("Use Cyberboss's persistent reminder/task mechanism when available"),
  "Template must guide agent to use Cyberboss's persistent reminder mechanism"
);
assert(
  templateContent.includes("If no Cyberboss reminder tool is available, reply normally and do not emulate a reminder by waiting inside the current process"),
  "Template must instruct normal reply without waiting if no reminder tool is available"
);

console.log("PROMPT_TEMPLATE_RULES_PASS");

// --------------------------------------------------
// Main Execution Runner
// --------------------------------------------------
async function runAll() {
  const fake = buildFakeCliExe();
  try {
    await testProcessClientGuard(fake);
    await testRuntimeAdapterGuard(fake);
  } finally {
    fake.cleanup();
  }
  console.log("\n==================================================");
  console.log("ALL STAGE 6.6 PERSISTENT-TOOL GUARD TESTS PASSED 100%!");
  console.log("==================================================");
}

runAll().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
