const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
  ensureAntigravityGlobalMcpConfig,
  computeAntigravityServerName,
  canonicalizeWorkspaceRoot,
  isCyberbossMcpServerEntry,
  resolveAntigravityMcpConfigPath,
} = require("../src/adapters/runtime/antigravity/mcp-settings");
const { resolveTargetRules } = require("../scripts/setup-antigravity-permissions");
const { CyberbossApp } = require("../src/core/app");

async function runTests() {
  console.log("Running Antigravity MCP cleanup and permission unit test suite...\n");
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mcp-test-"));

  try {
    // 1. mcp config 为空 -> 创建 canonical CyberBoss server
    await testCase("1. mcp config is empty -> creates canonical CyberBoss server", async () => {
      const configPath = path.join(tmpDir, "case1.json");
      const res = ensureAntigravityGlobalMcpConfig({
        workspaceRoot: "d:\\cyberboss",
        configPath,
      });
      assert.strictEqual(res.serverName, "cyberboss_tools_20965225");
      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      assert.ok(written.mcpServers["cyberboss_tools_20965225"]);
      assert.strictEqual(written.mcpServers["cyberboss_tools_20965225"].args.includes("d:\\cyberboss"), true);
    });

    // 2. 已有正确 canonical server -> 不重复
    await testCase("2. existing canonical server -> not duplicated", async () => {
      const configPath = path.join(tmpDir, "case2.json");
      ensureAntigravityGlobalMcpConfig({
        workspaceRoot: "d:\\cyberboss",
        configPath,
      });
      const res2 = ensureAntigravityGlobalMcpConfig({
        workspaceRoot: "d:\\cyberboss",
        configPath,
      });
      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const keys = Object.keys(written.mcpServers);
      assert.strictEqual(keys.length, 1);
      assert.strictEqual(keys[0], "cyberboss_tools_20965225");
    });

    // 3. 同一 workspace 有：cyberboss_tools_old, cyberboss_tools_current -> old 被删除, current 保留
    await testCase("3. same workspace old entry -> old removed, current retained", async () => {
      const configPath = path.join(tmpDir, "case3.json");
      const initial = {
        mcpServers: {
          cyberboss_tools_old1234: {
            command: process.execPath,
            args: [
              path.resolve(__dirname, "..", "bin", "cyberboss.js"),
              "tool-mcp-server",
              "--runtime-id",
              "antigravity",
              "--workspace-root",
              "d:\\cyberboss",
            ],
          },
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(initial, null, 2), "utf8");

      ensureAntigravityGlobalMcpConfig({
        workspaceRoot: "d:\\cyberboss",
        configPath,
      });

      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      assert.strictEqual(written.mcpServers.cyberboss_tools_old1234, undefined, "Old duplicate must be pruned");
      assert.ok(written.mcpServers.cyberboss_tools_20965225, "Canonical server must exist");
    });

    // 4. 路径：D:\cyberboss, d:\cyberboss, D:/cyberboss 视为同一 canonical workspace
    await testCase("4. case and separator variations resolve to same canonical workspace and hash", async () => {
      const c1 = canonicalizeWorkspaceRoot("d:\\cyberboss");
      const c2 = canonicalizeWorkspaceRoot("D:\\cyberboss");
      const c3 = canonicalizeWorkspaceRoot("D:/cyberboss");
      const c4 = canonicalizeWorkspaceRoot("d:\\cyberboss\\");

      assert.strictEqual(c1, c2);
      assert.strictEqual(c1, c3);
      assert.strictEqual(c1, c4);

      const h1 = computeAntigravityServerName("d:\\cyberboss");
      const h2 = computeAntigravityServerName("D:\\cyberboss");
      const h3 = computeAntigravityServerName("D:/cyberboss");
      assert.strictEqual(h1, "cyberboss_tools_20965225");
      assert.strictEqual(h2, "cyberboss_tools_20965225");
      assert.strictEqual(h3, "cyberboss_tools_20965225");

      const configPath = path.join(tmpDir, "case4.json");
      const initial = {
        mcpServers: {
          cyberboss_tools_old_slash: {
            command: process.execPath,
            args: [
              path.resolve(__dirname, "..", "bin", "cyberboss.js"),
              "tool-mcp-server",
              "--runtime-id",
              "antigravity",
              "--workspace-root",
              "D:/cyberboss",
            ],
          },
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(initial, null, 2), "utf8");
      ensureAntigravityGlobalMcpConfig({
        workspaceRoot: "d:\\cyberboss",
        configPath,
      });
      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      assert.strictEqual(written.mcpServers.cyberboss_tools_old_slash, undefined, "Old slash variation must be pruned");
      assert.ok(written.mcpServers.cyberboss_tools_20965225, "Canonical server must exist");
    });

    // 5. 不同 workspace 的：cyberboss_tools_other -> 必须保留
    await testCase("5. different workspace cyberboss_tools_other -> strictly preserved", async () => {
      const configPath = path.join(tmpDir, "case5.json");
      const otherWs = "D:\\other-project";
      const initial = {
        mcpServers: {
          cyberboss_tools_other_ws: {
            command: process.execPath,
            args: [
              path.resolve(__dirname, "..", "bin", "cyberboss.js"),
              "tool-mcp-server",
              "--runtime-id",
              "antigravity",
              "--workspace-root",
              otherWs,
            ],
          },
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(initial, null, 2), "utf8");

      ensureAntigravityGlobalMcpConfig({
        workspaceRoot: "d:\\cyberboss",
        configPath,
      });

      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      assert.ok(written.mcpServers.cyberboss_tools_other_ws, "Other workspace server must be preserved");
      assert.ok(written.mcpServers.cyberboss_tools_20965225, "Current canonical server must exist");
    });

    // 6. Veglia and third-party MCPs -> strictly preserved
    await testCase("6. Veglia and third-party MCPs -> strictly preserved", async () => {
      const configPath = path.join(tmpDir, "case6.json");
      const initial = {
        mcpServers: {
          MaaMCP: { command: "maa-mcp" },
          veglia: {
            command: "D:\\veglia\\.venv-mcp\\Scripts\\python.exe",
            args: ["D:\\veglia\\server\\veglia_mcp.py"],
          },
          fastctx: {
            command: "fastctx.exe",
            args: ["serve"],
          },
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(initial, null, 2), "utf8");

      ensureAntigravityGlobalMcpConfig({
        workspaceRoot: "d:\\cyberboss",
        configPath,
      });

      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      assert.ok(written.mcpServers.MaaMCP, "MaaMCP must be preserved");
      assert.ok(written.mcpServers.veglia, "veglia must be preserved");
      assert.ok(written.mcpServers.fastctx, "fastctx must be preserved");
      assert.ok(written.mcpServers.cyberboss_tools_20965225, "Current canonical server must exist");
    });

    // 7. malformed or non-standard server -> not accidentally deleted
    await testCase("7. malformed or non-standard server -> not accidentally deleted", async () => {
      const configPath = path.join(tmpDir, "case7.json");
      const initial = {
        mcpServers: {
          cyberboss_tools_fake1: { command: "node" },
          cyberboss_tools_fake2: { command: "node", args: ["something-else"] },
          cyberboss_tools_fake3: "invalid_string_entry",
          cyberboss_tools_fake4: { command: "node", args: ["tool-mcp-server", "--runtime-id", "other", "--workspace-root", "d:\\cyberboss"] },
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(initial, null, 2), "utf8");

      ensureAntigravityGlobalMcpConfig({
        workspaceRoot: "d:\\cyberboss",
        configPath,
      });

      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      assert.ok(written.mcpServers.cyberboss_tools_fake1, "Fake 1 preserved");
      assert.ok(written.mcpServers.cyberboss_tools_fake2, "Fake 2 preserved");
      assert.strictEqual(written.mcpServers.cyberboss_tools_fake3, "invalid_string_entry", "Fake 3 preserved");
      assert.ok(written.mcpServers.cyberboss_tools_fake4, "Fake 4 preserved");
      assert.ok(written.mcpServers.cyberboss_tools_20965225, "Current canonical server added");
    });

    // 8. unit tests use temp config -> real config untouched
    await testCase("8. unit tests use temp config -> real ~/.gemini/config is untouched", async () => {
      const realConfigPath = path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
      let realMtime = null;
      if (fs.existsSync(realConfigPath)) {
        realMtime = fs.statSync(realConfigPath).mtimeMs;
      }

      const tempConfig = path.join(tmpDir, "case8.json");
      ensureAntigravityGlobalMcpConfig({
        workspaceRoot: "d:\\temp-test-workspace",
        configPath: tempConfig,
      });

      assert.ok(fs.existsSync(tempConfig), "Temp config created");
      if (realMtime !== null) {
        const afterMtime = fs.statSync(realConfigPath).mtimeMs;
        assert.strictEqual(afterMtime, realMtime, "Real ~/.gemini/config/mcp_config.json must NOT be touched");
      }
    });

    // 9. permission setup outputs exact rule
    await testCase("9. permission setup outputs exact rule", async () => {
      const rules = resolveTargetRules({ workspaceRoot: "d:\\cyberboss" });
      assert.strictEqual(rules.serverName, "cyberboss_tools_20965225");
      assert.strictEqual(rules.mcpRule, "mcp(cyberboss_tools_20965225/*)");
      assert.ok(rules.targetRules.includes("mcp(cyberboss_tools_20965225/*)"));
    });

    // 10. no wildcard rules allowed
    await testCase("10. no wildcard rules allowed in rules output", async () => {
      const rules = resolveTargetRules({ workspaceRoot: "d:\\cyberboss" });
      for (const rule of rules.targetRules) {
        assert.ok(!rule.includes("mcp(*)"), "Wildcard forbidden");
        assert.ok(!rule.includes("cyberboss_tools*"), "Wildcard forbidden");
      }
    });

    // 11. sendFailureToThread delivery failure logs warning without throwing
    await testCase("11. sendFailureToThread delivery failure logs warning without throwing", async () => {
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));

      try {
        const mockApp = Object.create(CyberbossApp.prototype);
        mockApp.runtimeAdapter = {
          getSessionStore: () => ({
            findBindingForThreadId: () => ({ bindingKey: "user-1" }),
          }),
        };
        mockApp.resolveReplyTargetForBinding = () => ({
          userId: "test-user-id",
          contextToken: "token-123",
          source: "user",
        });
        mockApp.channelAdapter = {
          sendText: async () => {
            throw new Error("WeChat network error 500");
          },
        };

        await mockApp.sendFailureToThread("thread-xyz", "Test failure message");

        assert.strictEqual(warnings.length, 1, "Expected 1 warning logged");
        assert.ok(warnings[0].includes("[cyberboss] failed to deliver runtime failure to WeChat"), "Expected failure log message");
        assert.ok(warnings[0].includes("thread=thread-xyz"), "Log must include threadId");
        assert.ok(warnings[0].includes("user=test-user-id"), "Log must include userId");
        assert.ok(warnings[0].includes("WeChat network error 500"), "Log must include error message");
        assert.ok(!warnings[0].includes("token-123"), "Log must NOT leak contextToken");
      } finally {
        console.warn = originalWarn;
      }
    });

  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\nTests finished: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner threw unexpected error:", err);
  process.exit(1);
});
