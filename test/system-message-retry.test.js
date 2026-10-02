const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { SystemMessageQueueStore, normalizeSystemMessage, isMessageDue } = require("../src/core/system-message-queue-store");
const { SystemMessageDispatcher, SYSTEM_MESSAGE_RETRY_BACKOFF_MS, MAX_SYSTEM_MESSAGE_RETRIES } = require("../src/core/system-message-dispatcher");
const { CyberbossApp } = require("../src/core/app");

function createTempQueueFile() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-sys-msg-test-"));
  return path.join(tempDir, "system-message-queue.json");
}

test("1. check-in dispatch false: only attempted once, never requeued", () => {
  const filePath = createTempQueueFile();
  const queueStore = new SystemMessageQueueStore({ filePath });
  const dispatcher = new SystemMessageDispatcher({
    queueStore,
    config: { workspaceId: "default", workspaceRoot: "/workspace" },
    accountId: "account-1",
  });

  const checkinMsg = queueStore.enqueue({
    id: "checkin-1",
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: "/workspace",
    text: "User comes to mind again.",
    source: "checkin",
  });

  assert.equal(checkinMsg.source, "checkin");
  assert.equal(queueStore.hasPendingForAccount("account-1"), true);

  // Drain the message to simulate dispatch
  const drained = dispatcher.drainPending();
  assert.equal(drained.length, 1);
  assert.equal(queueStore.hasPendingForAccount("account-1"), false);

  // Dispatch returned false -> requeue called
  const requeueResult = dispatcher.requeue(drained[0]);
  assert.equal(requeueResult, null, "Checkin requeue must return null");

  // Queue must remain empty
  assert.equal(queueStore.hasPendingForAccount("account-1"), false);
  const reloaded = new SystemMessageQueueStore({ filePath });
  assert.equal(reloaded.hasPendingForAccount("account-1"), false);
});

test("2. check-in dispatch throw: app.flushPendingSystemMessages does not requeue check-in", async () => {
  const filePath = createTempQueueFile();
  const queueStore = new SystemMessageQueueStore({ filePath });
  const dispatcher = new SystemMessageDispatcher({
    queueStore,
    config: { workspaceId: "default", workspaceRoot: "/workspace" },
    accountId: "account-1",
  });

  queueStore.enqueue({
    id: "checkin-throw",
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: "/workspace",
    text: "User comes to mind again.",
    source: "checkin",
  });

  const appLike = {
    systemMessageDispatcher: dispatcher,
    async dispatchSystemMessage() {
      throw new Error("Antigravity turn failed: interactive OAuth timed out");
    },
  };

  // Run flushPendingSystemMessages which catches the error
  await CyberbossApp.prototype.flushPendingSystemMessages.call(appLike);

  // Checkin must NOT be requeued
  assert.equal(queueStore.hasPendingForAccount("account-1"), false);
});

test("3. regular system message first failure: attempts increments, nextAttemptAt in future, not immediately dispatched", () => {
  const filePath = createTempQueueFile();
  const queueStore = new SystemMessageQueueStore({ filePath });
  let currentTime = Date.parse("2026-09-09T06:20:00.000Z");

  const dispatcher = new SystemMessageDispatcher({
    queueStore,
    config: { workspaceId: "default", workspaceRoot: "/workspace" },
    accountId: "account-1",
    clock: () => currentTime,
  });

  const message = queueStore.enqueue({
    id: "sys-msg-1",
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: "/workspace",
    text: "Scheduled reminder",
    source: "system",
  });

  assert.equal(message.attempts, 0);
  assert.equal(message.nextAttemptAt, "");

  // Drain it for initial attempt
  const drained = dispatcher.drainPending(currentTime);
  assert.equal(drained.length, 1);

  // Dispatch fails -> requeue
  const requeued = dispatcher.requeue(drained[0]);
  assert.notEqual(requeued, null);
  assert.equal(requeued.attempts, 1);
  assert.equal(requeued.nextAttemptAt, new Date(currentTime + 60_000).toISOString());

  // Immediately querying at the same time: must NOT be due
  assert.equal(dispatcher.hasDue(currentTime), false);
  const nextDrain = dispatcher.drainPending(currentTime);
  assert.equal(nextDrain.length, 0, "Must not drain future-delayed message");
});

test("4. backoff not yet reached: drain/flush leaves message in persistent queue", () => {
  const filePath = createTempQueueFile();
  const queueStore = new SystemMessageQueueStore({ filePath });
  let currentTime = Date.parse("2026-09-09T06:20:00.000Z");

  const dispatcher = new SystemMessageDispatcher({
    queueStore,
    config: { workspaceId: "default", workspaceRoot: "/workspace" },
    accountId: "account-1",
    clock: () => currentTime,
  });

  queueStore.enqueue({
    id: "sys-backoff",
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: "/workspace",
    text: "Test backoff",
    source: "system",
    attempts: 1,
    nextAttemptAt: new Date(currentTime + 60_000).toISOString(),
  });

  // Advance time by 30 seconds (still 30s before 1m backoff expires)
  const midwayTime = currentTime + 30_000;
  assert.equal(dispatcher.hasDue(midwayTime), false);
  const drained = dispatcher.drainPending(midwayTime);
  assert.equal(drained.length, 0);

  // Message must still exist in persisted store
  const reloaded = new SystemMessageQueueStore({ filePath });
  assert.equal(reloaded.hasPendingForAccount("account-1"), true);
  assert.equal(reloaded.hasDueForAccount("account-1", midwayTime), false);
});

test("5. backoff reached: message becomes eligible for dispatch again", () => {
  const filePath = createTempQueueFile();
  const queueStore = new SystemMessageQueueStore({ filePath });
  let currentTime = Date.parse("2026-09-09T06:20:00.000Z");

  const dispatcher = new SystemMessageDispatcher({
    queueStore,
    config: { workspaceId: "default", workspaceRoot: "/workspace" },
    accountId: "account-1",
    clock: () => currentTime,
  });

  queueStore.enqueue({
    id: "sys-due",
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: "/workspace",
    text: "Test backoff reached",
    source: "system",
    attempts: 1,
    nextAttemptAt: new Date(currentTime + 60_000).toISOString(),
  });

  // Advance time past 60 seconds
  const dueTime = currentTime + 60_001;
  assert.equal(dispatcher.hasDue(dueTime), true);
  const drained = dispatcher.drainPending(dueTime);
  assert.equal(drained.length, 1);
  assert.equal(drained[0].id, "sys-due");
  assert.equal(drained[0].attempts, 1);
});

test("6. regular system message stops after at most 3 retries and is dropped", () => {
  const filePath = createTempQueueFile();
  const queueStore = new SystemMessageQueueStore({ filePath });
  let currentTime = Date.parse("2026-09-09T06:00:00.000Z");

  const dispatcher = new SystemMessageDispatcher({
    queueStore,
    config: { workspaceId: "default", workspaceRoot: "/workspace" },
    accountId: "account-1",
    clock: () => currentTime,
  });

  queueStore.enqueue({
    id: "sys-exhaust",
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: "/workspace",
    text: "Failing system task",
    source: "system",
  });

  // Initial attempt (attempts: 0) -> fails -> retry #1 (attempts: 1, 1m backoff)
  let [msg] = dispatcher.drainPending(currentTime);
  assert.equal(msg.attempts, 0);
  let requeued = dispatcher.requeue(msg);
  assert.equal(requeued.attempts, 1);
  assert.equal(requeued.nextAttemptAt, new Date(currentTime + 60_000).toISOString());

  // Retry #1 at currentTime + 1m -> fails -> retry #2 (attempts: 2, 5m backoff)
  currentTime += 60_000;
  [msg] = dispatcher.drainPending(currentTime);
  assert.equal(msg.attempts, 1);
  requeued = dispatcher.requeue(msg);
  assert.equal(requeued.attempts, 2);
  assert.equal(requeued.nextAttemptAt, new Date(currentTime + 300_000).toISOString());

  // Retry #2 at currentTime + 5m -> fails -> retry #3 (attempts: 3, 15m backoff)
  currentTime += 300_000;
  [msg] = dispatcher.drainPending(currentTime);
  assert.equal(msg.attempts, 2);
  requeued = dispatcher.requeue(msg);
  assert.equal(requeued.attempts, 3);
  assert.equal(requeued.nextAttemptAt, new Date(currentTime + 900_000).toISOString());

  // Retry #3 at currentTime + 15m -> fails -> EXHAUSTED (attempts > 3)
  currentTime += 900_000;
  [msg] = dispatcher.drainPending(currentTime);
  assert.equal(msg.attempts, 3);
  requeued = dispatcher.requeue(msg);
  assert.equal(requeued, null, "Must return null when retries exhausted");

  // Queue must be completely empty now
  assert.equal(queueStore.hasPendingForAccount("account-1"), false);
  const reloaded = new SystemMessageQueueStore({ filePath });
  assert.equal(reloaded.hasPendingForAccount("account-1"), false);
});

test("7. successful dispatch leaves no residue in queue", async () => {
  const filePath = createTempQueueFile();
  const queueStore = new SystemMessageQueueStore({ filePath });
  const dispatcher = new SystemMessageDispatcher({
    queueStore,
    config: { workspaceId: "default", workspaceRoot: "/workspace" },
    accountId: "account-1",
  });

  queueStore.enqueue({
    id: "sys-success",
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: "/workspace",
    text: "Will succeed",
    source: "system",
  });

  const appLike = {
    systemMessageDispatcher: dispatcher,
    async dispatchSystemMessage() {
      return true; // Dispatched successfully!
    },
  };

  await CyberbossApp.prototype.flushPendingSystemMessages.call(appLike);

  assert.equal(queueStore.hasPendingForAccount("account-1"), false);
  const reloaded = new SystemMessageQueueStore({ filePath });
  assert.equal(reloaded.hasPendingForAccount("account-1"), false);
});

test("8. backward compatibility: old queue format without retry metadata loads cleanly with default source='system'", () => {
  const filePath = createTempQueueFile();
  const legacyQueue = {
    messages: [
      {
        id: "legacy-1",
        accountId: "account-old",
        senderId: "user-old",
        workspaceRoot: "/workspace/old",
        text: "Legacy system task",
        createdAt: "2026-09-08T10:00:00.000Z",
      },
    ],
  };

  fs.writeFileSync(filePath, JSON.stringify(legacyQueue, null, 2), "utf8");

  const queueStore = new SystemMessageQueueStore({ filePath });
  assert.equal(queueStore.hasPendingForAccount("account-old"), true);
  assert.equal(queueStore.hasDueForAccount("account-old"), true);

  const drained = queueStore.drainForAccount("account-old");
  assert.equal(drained.length, 1);
  assert.equal(drained[0].id, "legacy-1");
  assert.equal(drained[0].source, "system", "Legacy messages must default to source='system'");
  assert.equal(drained[0].attempts, 0, "Legacy messages must default to attempts=0");
  assert.equal(drained[0].nextAttemptAt, "", "Legacy messages must default to nextAttemptAt=''");
});

test("9. queue persistence across restarts preserves attempts and nextAttemptAt", () => {
  const filePath = createTempQueueFile();
  const queue1 = new SystemMessageQueueStore({ filePath });

  queue1.enqueue({
    id: "persist-msg",
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: "/workspace",
    text: "Persisted task",
    source: "system",
    attempts: 2,
    nextAttemptAt: "2026-09-09T08:00:00.000Z",
  });

  // Re-open store from same file
  const queue2 = new SystemMessageQueueStore({ filePath });
  assert.equal(queue2.hasPendingForAccount("account-1"), true);

  const drained = queue2.drainForAccount("account-1", Date.parse("2026-09-09T08:01:00.000Z"));
  assert.equal(drained.length, 1);
  assert.equal(drained[0].id, "persist-msg");
  assert.equal(drained[0].source, "system");
  assert.equal(drained[0].attempts, 2);
  assert.equal(drained[0].nextAttemptAt, "2026-09-09T08:00:00.000Z");
});

test("10. account isolation: operations on one account do not affect other accounts", () => {
  const filePath = createTempQueueFile();
  const queueStore = new SystemMessageQueueStore({ filePath });

  queueStore.enqueue({
    id: "msg-acc1",
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: "/workspace",
    text: "Account 1 task",
    source: "system",
  });

  queueStore.enqueue({
    id: "msg-acc2",
    accountId: "account-2",
    senderId: "user-2",
    workspaceRoot: "/workspace",
    text: "Account 2 task",
    source: "system",
  });

  // Drain only account 1
  const drained1 = queueStore.drainForAccount("account-1");
  assert.equal(drained1.length, 1);
  assert.equal(drained1[0].accountId, "account-1");

  // Account 2 message must remain untouched
  assert.equal(queueStore.hasPendingForAccount("account-2"), true);
  const drained2 = queueStore.drainForAccount("account-2");
  assert.equal(drained2.length, 1);
  assert.equal(drained2[0].accountId, "account-2");
});

test("11. check-in poller is not blocked when system messages are delayed in future backoff", () => {
  const filePath = createTempQueueFile();
  const queueStore = new SystemMessageQueueStore({ filePath });
  const now = Date.parse("2026-09-09T06:20:00.000Z");

  queueStore.enqueue({
    id: "sys-delayed",
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: "/workspace",
    text: "Delayed system message",
    source: "system",
    attempts: 1,
    nextAttemptAt: new Date(now + 300_000).toISOString(), // 5m in future
  });

  // hasPending is true (there is a message in queue)
  assert.equal(queueStore.hasPendingForAccount("account-1"), true);

  // hasDueForAccount is FALSE (not due right now)
  assert.equal(queueStore.hasDueForAccount("account-1", now), false);

  // This guarantees check-in poller logic:
  // queue.hasDueForAccount(account.accountId) === false -> check-in does not skip
});
