const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { resolvePreferredSenderId } = require("../src/core/default-targets");
const { SessionStore } = require("../src/adapters/runtime/codex/session-store");
const { ReminderQueueStore } = require("../src/adapters/channel/weixin/reminder-queue-store");

function createTempDir(prefix = "cyberboss-target-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanTempDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {}
}

test("1. allowedUsers has A, but only B has contextToken and binding -> resolves B, never A", () => {
  const tempDir = createTempDir();
  const accountsDir = path.join(tempDir, "accounts");
  fs.mkdirSync(accountsDir, { recursive: true });

  const accountId = "test-bot";
  const userA = "user-A@im.wechat";
  const userB = "user-B@im.wechat";

  // Only user B has a context token
  fs.writeFileSync(
    path.join(accountsDir, `${accountId}.context-tokens.json`),
    JSON.stringify({ [userB]: "token-B" }),
    "utf8"
  );

  const sessionStore = new SessionStore({ filePath: path.join(tempDir, "sessions.json"), runtimeId: "antigravity" });
  sessionStore.setThreadIdForWorkspace(
    sessionStore.buildBindingKey({ workspaceId: "default", accountId, senderId: userB }),
    tempDir,
    "thread-B",
    { workspaceId: "default", accountId, senderId: userB }
  );

  const config = {
    workspaceId: "default",
    accountsDir,
    allowedUserIds: [userA], // userA is in allowed list!
  };

  const resolved = resolvePreferredSenderId({
    config,
    accountId,
    sessionStore,
  });

  assert.equal(resolved, userB, "Must resolve user B who has active contextToken and binding, not allowedUser A");
  cleanTempDir(tempDir);
});

test("2. single valid binding and contextToken -> resolves normally", () => {
  const tempDir = createTempDir();
  const accountsDir = path.join(tempDir, "accounts");
  fs.mkdirSync(accountsDir, { recursive: true });

  const accountId = "test-bot";
  const user1 = "user-1@im.wechat";

  fs.writeFileSync(
    path.join(accountsDir, `${accountId}.context-tokens.json`),
    JSON.stringify({ [user1]: "token-1" }),
    "utf8"
  );

  const sessionStore = new SessionStore({ filePath: path.join(tempDir, "sessions.json"), runtimeId: "antigravity" });
  sessionStore.setThreadIdForWorkspace(
    sessionStore.buildBindingKey({ workspaceId: "default", accountId, senderId: user1 }),
    tempDir,
    "thread-1",
    { workspaceId: "default", accountId, senderId: user1 }
  );

  const config = { workspaceId: "default", accountsDir };
  const resolved = resolvePreferredSenderId({ config, accountId, sessionStore });

  assert.equal(resolved, user1, "Must resolve single active user");
  cleanTempDir(tempDir);
});

test("3. multiple candidates with contextToken -> ambiguous, returns empty", () => {
  const tempDir = createTempDir();
  const accountsDir = path.join(tempDir, "accounts");
  fs.mkdirSync(accountsDir, { recursive: true });

  const accountId = "test-bot";
  const user1 = "user-1@im.wechat";
  const user2 = "user-2@im.wechat";

  fs.writeFileSync(
    path.join(accountsDir, `${accountId}.context-tokens.json`),
    JSON.stringify({ [user1]: "token-1", [user2]: "token-2" }),
    "utf8"
  );

  const sessionStore = new SessionStore({ filePath: path.join(tempDir, "sessions.json"), runtimeId: "antigravity" });
  sessionStore.setThreadIdForWorkspace(
    sessionStore.buildBindingKey({ workspaceId: "default", accountId, senderId: user1 }),
    tempDir,
    "thread-1",
    { workspaceId: "default", accountId, senderId: user1 }
  );
  sessionStore.setThreadIdForWorkspace(
    sessionStore.buildBindingKey({ workspaceId: "default", accountId, senderId: user2 }),
    tempDir,
    "thread-2",
    { workspaceId: "default", accountId, senderId: user2 }
  );

  const config = { workspaceId: "default", accountsDir };
  const resolved = resolvePreferredSenderId({ config, accountId, sessionStore });

  assert.equal(resolved, "", "Must return empty string when targets are ambiguous");
  cleanTempDir(tempDir);
});

test("4. no valid contextToken -> returns empty with warning", () => {
  const tempDir = createTempDir();
  const accountsDir = path.join(tempDir, "accounts");
  fs.mkdirSync(accountsDir, { recursive: true });

  const accountId = "test-bot";
  const user1 = "user-1@im.wechat";

  // Empty tokens file
  fs.writeFileSync(
    path.join(accountsDir, `${accountId}.context-tokens.json`),
    JSON.stringify({}),
    "utf8"
  );

  const sessionStore = new SessionStore({ filePath: path.join(tempDir, "sessions.json"), runtimeId: "antigravity" });
  sessionStore.setThreadIdForWorkspace(
    sessionStore.buildBindingKey({ workspaceId: "default", accountId, senderId: user1 }),
    tempDir,
    "thread-1",
    { workspaceId: "default", accountId, senderId: user1 }
  );

  const config = { workspaceId: "default", accountsDir, allowedUserIds: [user1] };
  const resolved = resolvePreferredSenderId({ config, accountId, sessionStore });

  assert.equal(resolved, "", "Must return empty string when no token exists");
  cleanTempDir(tempDir);
});

test("5. explicitUser with valid token is accepted; without token is rejected", () => {
  const tempDir = createTempDir();
  const accountsDir = path.join(tempDir, "accounts");
  fs.mkdirSync(accountsDir, { recursive: true });

  const accountId = "test-bot";
  const userValid = "user-valid@im.wechat";
  const userNoToken = "user-notoken@im.wechat";

  fs.writeFileSync(
    path.join(accountsDir, `${accountId}.context-tokens.json`),
    JSON.stringify({ [userValid]: "valid-token" }),
    "utf8"
  );

  const config = { workspaceId: "default", accountsDir };

  const resolvedValid = resolvePreferredSenderId({
    config,
    accountId,
    explicitUser: userValid,
  });
  assert.equal(resolvedValid, userValid, "Explicit user with token must be accepted");

  const resolvedInvalid = resolvePreferredSenderId({
    config,
    accountId,
    explicitUser: userNoToken,
  });
  assert.equal(resolvedInvalid, "", "Explicit user without token must be rejected");

  cleanTempDir(tempDir);
});

test("6. reminder due uses its own persisted senderId, unaffected by proactive resolver", () => {
  const tempDir = createTempDir();
  const reminderQueue = new ReminderQueueStore({ filePath: path.join(tempDir, "reminders.json") });

  const reminder = reminderQueue.enqueue({
    id: "rem-1",
    accountId: "acc-1",
    senderId: "specific-user@im.wechat",
    contextToken: "token-rem-123",
    text: "喝水提醒",
    dueAtMs: Date.now() - 1000,
    createdAt: new Date().toISOString(),
    origin: "user",
    deliveryRequired: true,
  });

  const due = reminderQueue.listDue(Date.now());
  assert.equal(due.length, 1);
  assert.equal(due[0].senderId, "specific-user@im.wechat", "Reminder preserves its own senderId");
  assert.equal(due[0].contextToken, "token-rem-123", "Reminder preserves its own contextToken");
  cleanTempDir(tempDir);
});
