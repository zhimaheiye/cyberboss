const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

async function main() {
  const cwd = process.cwd();
  
  // 1. Verify that mcp_config.json was populated by the adapter
  const configPath =
    process.env.CYBERBOSS_ANTIGRAVITY_MCP_CONFIG_PATH ||
    path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
  
  if (!fs.existsSync(configPath)) {
    console.error("mock-agy-cli: mcp_config.json not found");
    process.exit(1);
  }
  
  const configRaw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(configRaw);
  
  const pathForHash = process.platform === "win32" ? cwd.toLowerCase().replace(/\\/g, "/") : cwd;
  const hash = crypto.createHash("md5").update(pathForHash).digest("hex").slice(0, 8);
  const serverName = `cyberboss_tools_${hash}`;
  
  if (!config.mcpServers || !config.mcpServers[serverName]) {
    console.error(`mock-agy-cli: expected server ${serverName} not found in mcp_config.json`);
    process.exit(1);
  }
  
  const serverConfig = config.mcpServers[serverName];
  const hasCwd = serverConfig.args.some((arg) => typeof arg === "string" && arg.toLowerCase() === cwd.toLowerCase());
  if (!serverConfig.args.includes("tool-mcp-server") || !hasCwd) {
    console.error(`mock-agy-cli: server config arguments are incorrect: ${JSON.stringify(serverConfig.args)}`);
    process.exit(1);
  }

  // 2. Mock Antigravity json stream output
  const initEvent = { event: "init", conversation_id: "mock-thread-123" };
  const resultEvent = {
    event: "result",
    result: {
      conversation_id: "mock-thread-123",
      response: "Mock response that proves tool integration logic fired and succeeded",
      status: "SUCCESS"
    }
  };
  
  console.log(JSON.stringify(initEvent));
  
  // Simulate some delay
  await new Promise(r => setTimeout(r, 200));
  
  console.log(JSON.stringify(resultEvent));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
