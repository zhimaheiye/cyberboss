const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  SessionStore,
  normalizeWorkspacePath,
  migrateSessionStoreState,
} = require("../src/adapters/runtime/codex/session-store");

function createTempSessionFile() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-session-test-"));
  return path.join(tempDir, "sessions.json");
}

test("1. normalizeWorkspacePath on Windows converts to canonical lowercase and normalized slashes", () => {
  assert.equal(normalizeWorkspacePath("D:\\cyberboss", "win32"), "d:\\cyberboss");
  assert.equal(normalizeWorkspacePath("d:\\cyberboss", "win32"), "d:\\cyberboss");
  assert.equal(normalizeWorkspacePath("D:/cyberboss", "win32"), "d:\\cyberboss");
  assert.equal(normalizeWorkspacePath("D:\\CYBERBOSS\\sub", "win32"), "d:\\cyberboss\\sub");
  assert.equal(normalizeWorkspacePath("  D:\\cyberboss  ", "win32"), "d:\\cyberboss");
  assert.equal(normalizeWorkspacePath("", "win32"), "");
  assert.equal(normalizeWorkspacePath(null, "win32"), "");
});

test("2. normalizeWorkspacePath on POSIX preserves case sensitivity", () => {
  assert.equal(normalizeWorkspacePath("/home/user/Project", "linux"), "/home/user/Project");
  assert.equal(normalizeWorkspacePath("/home/user/project", "linux"), "/home/user/project");
  assert.notEqual(
    normalizeWorkspacePath("/home/user/Project", "linux"),
    normalizeWorkspacePath("/home/user/project", "linux")
  );
  assert.equal(normalizeWorkspacePath("/home/user/../user/Project", "linux"), "/home/user/Project");
});

test("3. SessionStore get/set threadId is case-insensitive on Windows", () => {
  const filePath = createTempSessionFile();
  const store = new SessionStore({ filePath, runtimeId: "antigravity" });
  const bindingKey = "test-binding-1";

  store.setThreadIdForWorkspace(bindingKey, "D:\\cyberboss", "agy-thread-100");

  // Querying with different casings or slashes returns the same thread
  assert.equal(store.getThreadIdForWorkspace(bindingKey, "d:\\cyberboss"), "agy-thread-100");
  assert.equal(store.getThreadIdForWorkspace(bindingKey, "D:/cyberboss"), "agy-thread-100");
  assert.equal(store.getThreadIdForWorkspace(bindingKey, "d:/cyberboss"), "agy-thread-100");
  assert.equal(store.getActiveWorkspaceRoot(bindingKey), "d:\\cyberboss");

  // Querying findBindingForThreadId
  const found = store.findBindingForThreadId("agy-thread-100", "antigravity");
  assert.equal(found.bindingKey, bindingKey);
  assert.equal(found.workspaceRoot, "d:\\cyberboss");
});

test("4. SessionStore get/set runtimeParams is case-insensitive on Windows", () => {
  const filePath = createTempSessionFile();
  const store = new SessionStore({ filePath, runtimeId: "antigravity" });
  const bindingKey = "test-binding-2";

  store.setRuntimeParamsForWorkspace(bindingKey, "D:\\cyberboss", {
    model: "gemini-2.5",
    modelProvider: "google",
  });

  const params1 = store.getRuntimeParamsForWorkspace(bindingKey, "d:\\cyberboss");
  assert.equal(params1.model, "gemini-2.5");
  assert.equal(params1.modelProvider, "google");

  const params2 = store.getRuntimeParamsForWorkspace(bindingKey, "D:/cyberboss");
  assert.equal(params2.model, "gemini-2.5");
});

test("5. migrateSessionStoreState consolidates conflicting Windows workspaces and preserves active thread", () => {
  const rawState = {
    bindings: {
      "binding-active-test": {
        workspaceId: "default",
        accountId: "1decbfbc2fb5-im.bot",
        senderId: "o9cq807KjJnkVo_Qng4I9hL61FUg@im.wechat",
        activeWorkspaceRoot: "D:\\cyberboss",
        threadIdByWorkspaceRootByRuntime: {
          antigravity: {
            "d:\\cyberboss": "old-thread-56ab1313",
            "D:\\cyberboss": "active-thread-298a2b1f",
          },
          claudecode: {
            "d:\\cyberboss": "old-claude-thread",
            "D:\\cyberboss": "active-claude-thread",
          },
          codex: {
            "d:\\cyberboss": "codex-thread-1",
          },
        },
        runtimeParamsByWorkspaceRootByRuntime: {
          antigravity: {
            "d:\\cyberboss": { model: "old-model" },
            "D:\\cyberboss": { model: "active-model" },
          },
        },
      },
    },
  };

  const migrated = migrateSessionStoreState(rawState, "win32");
  const binding = migrated.bindings["binding-active-test"];

  // Canonical workspace root is lowercased
  assert.equal(binding.activeWorkspaceRoot, "d:\\cyberboss");

  // Account and sender IDs preserve casing
  assert.equal(binding.accountId, "1decbfbc2fb5-im.bot");
  assert.equal(binding.senderId, "o9cq807KjJnkVo_Qng4I9hL61FUg@im.wechat");

  // Conflicting antigravity threads resolved in favor of activeWorkspaceRoot ("D:\cyberboss")
  assert.deepEqual(binding.threadIdByWorkspaceRootByRuntime.antigravity, {
    "d:\\cyberboss": "active-thread-298a2b1f",
  });

  // Conflicting claudecode threads resolved in favor of activeWorkspaceRoot ("D:\cyberboss")
  assert.deepEqual(binding.threadIdByWorkspaceRootByRuntime.claudecode, {
    "d:\\cyberboss": "active-claude-thread",
  });

  // Non-conflicting codex thread preserved
  assert.deepEqual(binding.threadIdByWorkspaceRootByRuntime.codex, {
    "d:\\cyberboss": "codex-thread-1",
  });

  // Runtime params for active workspace preserved
  assert.equal(
    binding.runtimeParamsByWorkspaceRootByRuntime.antigravity["d:\\cyberboss"].model,
    "active-model"
  );
});

test("6. migrateSessionStoreState resolves non-active conflicts deterministically with warning", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    const rawState = {
      bindings: {
        "binding-non-active": {
          activeWorkspaceRoot: "E:\\other-project",
          threadIdByWorkspaceRootByRuntime: {
            antigravity: {
              "d:\\cyberboss": "thread-a",
              "D:\\cyberboss": "thread-b",
            },
          },
        },
      },
    };

    const migrated = migrateSessionStoreState(rawState, "win32");
    const binding = migrated.bindings["binding-non-active"];

    // Must deterministically pick one
    assert.ok(binding.threadIdByWorkspaceRootByRuntime.antigravity["d:\\cyberboss"]);
    // Must have printed a warning
    assert.ok(warnings.some((w) => w.includes("session-store migrated conflicting workspace keys")));
  } finally {
    console.warn = originalWarn;
  }
});

test("7. migrateSessionStoreState on real backup data preserves 298a2b1f conversation", () => {
  const backupPath = "C:/Users/Administrator/.cyberboss/sessions.json.2026-09-09T10-15-12-215Z.bak";
  if (!fs.existsSync(backupPath)) {
    return;
  }
  const raw = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  const migrated = migrateSessionStoreState(raw, "win32");
  const binding = migrated.bindings["default:1decbfbc2fb5-im.bot:o9cq807KjJnkVo_Qng4I9hL61FUg@im.wechat"];

  assert.equal(binding.activeWorkspaceRoot, "d:\\cyberboss");
  assert.equal(binding.threadIdByWorkspaceRootByRuntime.antigravity["d:\\cyberboss"], "298a2b1f-5353-4556-9af2-806eaefcf0df");
  assert.equal(binding.threadIdByWorkspaceRootByRuntime.claudecode["d:\\cyberboss"], "99af8504-ac1c-406f-a430-6e63b0b65169");
  assert.equal(binding.threadIdByWorkspaceRootByRuntime.codex["d:\\cyberboss"], "01a01ed2-b970-7de3-9b11-b312ec639cd7");
});
