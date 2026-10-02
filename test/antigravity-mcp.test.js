const cp = require("child_process");
const path = require("path");
const os = require("os");
const originalSpawn = cp.spawn;

cp.spawn = function(command, args, options) {
  if (command === "mock-agy") {
    return originalSpawn(process.execPath, [path.join(__dirname, "mock-agy-cli.js"), ...args], options);
  }
  return originalSpawn(command, args, options);
};

const { createAntigravityRuntimeAdapter } = require("../src/adapters/runtime/antigravity/index.js");

async function runTest() {
  console.log("Starting zero-quota Antigravity MCP integration test...");
  const workspaceRoot = process.cwd();
  const sessionsFile = path.join(workspaceRoot, "sessions-test.json");
  const tempMcpConfig = path.join(os.tmpdir(), `cyberboss-mcp-test-${Date.now()}.json`);
  process.env.CYBERBOSS_ANTIGRAVITY_MCP_CONFIG_PATH = tempMcpConfig;

  const adapter = createAntigravityRuntimeAdapter({
    sessionsFile,
    antigravityCommand: "mock-agy",
    antigravityMcpConfigPath: tempMcpConfig,
  });

  let failed = false;
  try {
    const turnResult = await adapter.sendTurn({
      bindingKey: "test-binding",
      workspaceRoot,
      text: "Hello test",
      model: "mock-model",
    });

    console.log("Turn completed successfully:", turnResult);
    if (turnResult.threadId !== "mock-thread-123") {
      throw new Error(`Expected threadId 'mock-thread-123', got '${turnResult.threadId}'`);
    }
    
    console.log("SUCCESS: Antigravity MCP integration test passed.");
  } catch (err) {
    console.error("FAILED: Test threw an error:", err);
    failed = true;
  } finally {
    await adapter.close();
  }
  
  if (failed) {
    process.exit(1);
  }
}

runTest();
