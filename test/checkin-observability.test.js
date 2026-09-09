const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp, formatCheckinErrorMessage } = require("../src/core/app");

test("1. formatCheckinErrorMessage redacts Bearer tokens and sensitive credentials", () => {
  const err1 = new Error("Request failed: Bearer ya29.a0AfH6SMtest123456789 expired");
  assert.equal(
    formatCheckinErrorMessage(err1),
    "Request failed: Bearer [REDACTED] expired"
  );

  const err2 = new Error("Failed with token: abcdef123456 and secret=9876543210zyx");
  const sanitized2 = formatCheckinErrorMessage(err2);
  assert.ok(!sanitized2.includes("abcdef123456"));
  assert.ok(!sanitized2.includes("9876543210zyx"));
  assert.ok(sanitized2.includes("[REDACTED]"));

  const err3 = new Error("Line 1\r\nLine 2\nLine 3");
  assert.equal(formatCheckinErrorMessage(err3), "Line 1 Line 2 Line 3");

  const longStr = "E".repeat(500);
  const truncated = formatCheckinErrorMessage(new Error(longStr), 50);
  assert.equal(truncated.length, 53); // 50 chars + "..."
  assert.ok(truncated.endsWith("..."));
});

test("2. dispatchPreparedTurn on normal message failure sends WeChat text and does not warn checkin", async () => {
  const sentTexts = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    let released = false;
    const appLike = {
      turnGateStore: {
        begin: () => "scope-1",
        releaseScope: () => { released = true; },
        attachThread: () => {},
      },
      channelAdapter: {
        sendTyping: async () => {},
        sendText: async (payload) => { sentTexts.push(payload); },
      },
      runtimeAdapter: {
        getSessionStore: () => ({
          getRuntimeParamsForWorkspace: () => ({ model: "" }),
        }),
        describe: () => ({ id: "antigravity" }),
        sendTurn: async () => {
          throw new Error("Normal turn failed: model timed out");
        },
      },
      buildRuntimeTurn: async () => ({ text: "hello", attachments: [] }),
    };

    const prepared = {
      workspaceId: "default",
      accountId: "account-1",
      senderId: "user-1",
      contextToken: "token-1",
      source: "chat",
      text: "hello bot",
    };

    const result = await CyberbossApp.prototype.dispatchPreparedTurn.call(appLike, {
      bindingKey: "b-1",
      workspaceRoot: "d:\\cyberboss",
      prepared,
    });

    assert.equal(result, false, "Turn dispatch must return false on failure");
    assert.equal(released, true, "TurnGateStore scope must be released");
    assert.equal(sentTexts.length, 1, "Must send text to WeChat on normal chat failure");
    assert.equal(sentTexts[0].userId, "user-1");
    assert.ok(sentTexts[0].text.includes("❌ Request failed"));
    assert.ok(sentTexts[0].text.includes("model timed out"));

    // Checkin warning should NOT have been printed
    assert.equal(
      warnings.some((w) => w.includes("checkin runtime failed")),
      false,
      "Must not log checkin warning for normal messages"
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("3. dispatchPreparedTurn on check-in message failure logs sanitized warning and sends NO WeChat text", async () => {
  const sentTexts = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    let released = false;
    const appLike = {
      turnGateStore: {
        begin: () => "scope-1",
        releaseScope: () => { released = true; },
        attachThread: () => {},
      },
      channelAdapter: {
        sendTyping: async () => {},
        sendText: async (payload) => { sentTexts.push(payload); },
      },
      runtimeAdapter: {
        getSessionStore: () => ({
          getRuntimeParamsForWorkspace: () => ({ model: "" }),
        }),
        describe: () => ({ id: "antigravity" }),
        sendTurn: async () => {
          throw new Error("Antigravity turn failed: exit status 1\nBearer ya29.secretToken12345");
        },
      },
      buildRuntimeTurn: async () => ({ text: "system checkin", attachments: [] }),
    };

    const prepared = {
      workspaceId: "default",
      accountId: "account-1",
      senderId: "user-1",
      contextToken: "token-checkin",
      source: "checkin",
      text: "checkin trigger",
    };

    const result = await CyberbossApp.prototype.dispatchPreparedTurn.call(appLike, {
      bindingKey: "b-1",
      workspaceRoot: "d:\\cyberboss",
      prepared,
    });

    assert.equal(result, false, "Turn dispatch must return false on failure");
    assert.equal(released, true, "TurnGateStore scope must be released");
    assert.equal(sentTexts.length, 0, "Must NEVER send WeChat text on checkin failure");

    // Checkin warning MUST have been printed
    const checkinWarn = warnings.find((w) => w.includes("[cyberboss] checkin runtime failed:"));
    assert.ok(checkinWarn, "Must log checkin runtime failed warning");
    assert.ok(checkinWarn.includes("exit status 1"));
    assert.ok(checkinWarn.includes("Bearer [REDACTED]"));
    assert.ok(!checkinWarn.includes("ya29.secretToken12345"));
    assert.ok(!checkinWarn.includes("\n"), "Must be single-line");
  } finally {
    console.warn = originalWarn;
  }
});
