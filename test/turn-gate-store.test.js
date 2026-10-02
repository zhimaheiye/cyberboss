const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");
const { TurnGateStore } = require("../src/core/turn-gate-store");

test("turn gate tracks pending scopes until the turn is released", () => {
  const gate = new TurnGateStore();
  const scopeKey = gate.begin("binding-1", "/workspace");

  assert.equal(scopeKey, "binding-1::/workspace");
  assert.equal(gate.isPending("binding-1", "/workspace"), true);

  gate.attachThread(scopeKey, "thread-1");
  gate.releaseThread("thread-1");

  assert.equal(gate.isPending("binding-1", "/workspace"), false);
});

test("handlePreparedMessage queues a normal inbound message while the scope is busy", async () => {
  const queued = [];
  let dispatched = false;
  const appLike = {
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "running", pendingApproval: null };
      },
    },
    turnGateStore: {
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    streamDelivery: {
      setReplyTarget() {},
    },
    pendingInboundByScope: new Map(),
    hasPendingImageInbound() {
      return false;
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        text: "prepared-user-text",
      };
    },
    async dispatchPreparedTurn() {
      dispatched = true;
      return true;
    },
    bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
      queued.push({ bindingKey, workspaceRoot, ...prepared });
    },
    isTurnDispatchBlocked: CyberbossApp.prototype.isTurnDispatchBlocked,
    routePreparedInbound: CyberbossApp.prototype.routePreparedInbound,
  };

  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "acc-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "hello",
    receivedAt: "2026-04-13T08:00:00.000Z",
  }, { allowCommands: true });

  assert.equal(dispatched, false);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].bindingKey, "binding-1");
  assert.equal(queued[0].workspaceRoot, "/workspace");
  assert.equal(queued[0].text, "prepared-user-text");
});

test("dispatchSystemMessage yields when a local pending turn already owns the workspace thread", async () => {
  let handled = false;
  const appLike = {
    systemMessageDispatcher: {
      buildPreparedMessage() {
        return {
          workspaceId: "default",
          accountId: "acc-1",
          senderId: "user-1",
          workspaceRoot: "/workspace",
        };
      },
    },
    channelAdapter: {
      getKnownContextTokens() {
        return { "user-1": "ctx-1" };
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return null;
      },
    },
    turnGateStore: {
      isPending() {
        return true;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async handlePreparedMessage() {
      handled = true;
    },
    isTurnDispatchBlocked: CyberbossApp.prototype.isTurnDispatchBlocked,
  };

  const dispatched = await CyberbossApp.prototype.dispatchSystemMessage.call(appLike, {
    senderId: "user-1",
    id: "system-1",
    text: "ping",
  });

  assert.equal(dispatched, false);
  assert.equal(handled, false);
});

test("handlePreparedMessage queues while the scope is in a turn-boundary handoff", async () => {
  const queued = [];
  let dispatched = false;
  const appLike = {
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "completed", pendingApproval: null };
      },
    },
    turnGateStore: {
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(["binding-1::/workspace"]),
    streamDelivery: {
      setReplyTarget() {},
    },
    pendingInboundByScope: new Map(),
    hasPendingImageInbound() {
      return false;
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        text: "prepared-user-text",
      };
    },
    async dispatchPreparedTurn() {
      dispatched = true;
      return true;
    },
    bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
      queued.push({ bindingKey, workspaceRoot, ...prepared });
    },
    isTurnDispatchBlocked: CyberbossApp.prototype.isTurnDispatchBlocked,
    routePreparedInbound: CyberbossApp.prototype.routePreparedInbound,
  };

  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "acc-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "hello",
    receivedAt: "2026-04-13T08:00:00.000Z",
  }, { allowCommands: true });

  assert.equal(dispatched, false);
  assert.equal(queued.length, 1);
});

test("dispatchPreparedTurn binds reply target to the explicit turn id when runtime returns one", async () => {
  const turnBindings = [];
  const queuedBindings = [];
  const order = [];
  const appLike = {
    channelAdapter: {
      async sendTyping() {
        order.push("typing");
      },
      async sendText() {},
    },
    turnGateStore: {
      begin() {
        order.push("begin");
        return "binding-1::/workspace";
      },
      attachThread() {},
      releaseScope() {},
    },
    runtimeAdapter: {
      async sendTextTurn() {
        return { threadId: "thread-1", turnId: "turn-1" };
      },
      getSessionStore() {
        return {
          getRuntimeParamsForWorkspace() {
            return { model: "gpt-5.4" };
          },
        };
      },
    },
    async buildRuntimeTurn({ prepared }) {
      return {
        text: prepared.text,
        attachments: [],
      };
    },
    streamDelivery: {
      bindReplyTargetForTurn(payload) {
        turnBindings.push(payload);
      },
      queueReplyTargetForThread(threadId, target) {
        queuedBindings.push({ threadId, target });
      },
    },
  };

  const dispatched = await CyberbossApp.prototype.dispatchPreparedTurn.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "acc-1",
      senderId: "user-1",
      contextToken: "ctx-1",
      provider: "system",
      text: "ping",
    },
  });

  assert.equal(dispatched, true);
  assert.deepEqual(turnBindings, [{
    threadId: "thread-1",
    turnId: "turn-1",
    target: {
      userId: "user-1",
      contextToken: "ctx-1",
      provider: "system",
    },
  }]);
  assert.deepEqual(queuedBindings, []);
  assert.deepEqual(order, ["begin", "typing"]);
});

test("completed turns flush queued inbound work before system messages", async () => {
  const calls = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return {
              bindingKey: "binding-1",
              workspaceRoot: "/workspace",
            };
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {
        calls.push("releaseThread");
      },
      releaseScope() {
        calls.push("releaseScope");
      },
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return false;
    },
    async stopTypingForThread() {
      calls.push("stopTyping");
    },
    async sendFailureToThread() {
      calls.push("sendFailure");
    },
    async flushPendingInboundMessages({ ignoreBoundary } = {}) {
      calls.push(`flushInbound:${ignoreBoundary ? "ignoreBoundary" : "default"}`);
    },
    async flushPendingSystemMessages() {
      calls.push("flushSystem");
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(calls, ["releaseThread", "releaseScope", "flushInbound:ignoreBoundary", "flushSystem", "stopTyping"]);
});

test("completed turns keep the boundary closed until queued inbound work has been flushed", async () => {
  const calls = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return {
              bindingKey: "binding-1",
              workspaceRoot: "/workspace",
            };
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {
        calls.push("releaseThread");
      },
      releaseScope() {
        calls.push("releaseScope");
      },
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return true;
    },
    async stopTypingForThread() {
      calls.push("stopTyping");
    },
    async sendFailureToThread() {},
    async flushPendingInboundMessages({ ignoreBoundary } = {}) {
      calls.push(`flushInbound:${ignoreBoundary ? "ignoreBoundary" : "default"}`);
      assert.equal(this.turnBoundaryScopeKeys.has("binding-1::/workspace"), true);
    },
    async flushPendingSystemMessages() {
      calls.push("flushSystem");
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(calls, ["releaseThread", "releaseScope", "flushInbound:ignoreBoundary", "flushSystem"]);
  assert.equal(appLike.turnBoundaryScopeKeys.has("binding-1::/workspace"), false);
});

test("completed turns flush queued inbound work before system messages", async () => {
  const calls = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {
        calls.push("releaseThread");
      },
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return false;
    },
    async stopTypingForThread() {
      calls.push("stopTyping");
    },
    async sendFailureToThread() {
      calls.push("sendFailure");
    },
    async flushPendingInboundMessages() {
      calls.push("flushInbound");
    },
    async flushPendingSystemMessages() {
      calls.push("flushSystem");
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(calls, ["releaseThread", "flushInbound", "flushSystem", "stopTyping"]);
});

test("failed turns still send error back when thread binding lookup is missing", async () => {
  const sent = [];
  const appLike = {
    streamDelivery: {
      resolveReplyTargetForRun() {
        return {
          userId: "user-1",
          contextToken: "ctx-1",
          provider: "weixin",
        };
      },
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
          getBinding() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {},
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return false;
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
    async sendFailureToThread(threadId, text, fallbackTarget) {
      return CyberbossApp.prototype.sendFailureToThread.call(this, threadId, text, fallbackTarget);
    },
    async stopTypingForThread() {},
    async flushPendingInboundMessages() {},
    async flushPendingSystemMessages() {},
    resolveReplyTargetForBinding() {
      return null;
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.failed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      text: "❌ Execution failed\ncontext window exceeded",
    },
  });

  assert.deepEqual(sent, [{
    userId: "user-1",
    text: "❌ Execution failed\ncontext window exceeded",
    contextToken: "ctx-1",
  }]);
});

test("flushPendingInboundMessages batches queued messages from the same scope into one turn", async () => {
  const dispatched = [];
  const scopeKey = "binding-1::/workspace";
  const appLike = {
    pendingInboundByScope: new Map([[
      scopeKey,
      {
        bindingKey: "binding-1",
        workspaceRoot: "/workspace",
        messages: [
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "102",
            contextToken: "ctx-1",
            provider: "weixin",
            text: "[2026-04-13 16:01]\n第二条",
            receivedAt: "2026-04-13T08:00:02.000Z",
          },
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "101",
            contextToken: "ctx-2",
            provider: "weixin",
            text: "[2026-04-13 16:00]\n第一条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
        ],
      },
    ]]),
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
  };

  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].prepared.contextToken, "ctx-1");
  assert.match(dispatched[0].prepared.text, /Multiple newer WeChat messages arrived/);
  assert.match(dispatched[0].prepared.text, /第一条[\s\S]*第二条/);
});

test("flushPendingInboundMessages falls back to messageId ordering when receivedAt ties", async () => {
  const dispatched = [];
  const appLike = {
    pendingInboundByScope: new Map([[
      "binding-1::/workspace",
      {
        bindingKey: "binding-1",
        workspaceRoot: "/workspace",
        messages: [
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "200",
            contextToken: "ctx-200",
            provider: "weixin",
            text: "第三条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "198",
            contextToken: "ctx-198",
            provider: "weixin",
            text: "第一条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "199",
            contextToken: "ctx-199",
            provider: "weixin",
            text: "第二条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
        ],
      },
    ]]),
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
    mergePendingInboundDraft: CyberbossApp.prototype.mergePendingInboundDraft,
  };

  await CyberbossApp.prototype.flushPendingInboundMessages.call(appLike);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].prepared.contextToken, "ctx-200");
  assert.match(dispatched[0].prepared.text, /第一条[\s\S]*第二条[\s\S]*第三条/);
});

// ──────────────────────────────────────────────────────────────────────────────
// AGY terminal-event timing race regression tests
//
// These tests replicate the race where the Antigravity CLI emits its result
// event synchronously during process.on("close"), which means
// runtime.turn.completed reaches handleRuntimeEvent *before* sendTurn()
// resolves and dispatchPreparedTurn calls attachThread().
//
// Before the fix:  releaseThread() found no scopeByThreadId entry → returned
//                  without clearing pendingScopeKeys → subsequent messages were
//                  buffered forever.
// After the fix:   handleRuntimeEvent calls releaseScope() as a fallback when
//                  the binding is already known from SessionStore.
// ──────────────────────────────────────────────────────────────────────────────

test("AGY race: terminal event before attachThread — TurnGateStore.releaseScope clears the pending scope", () => {
  const gate = new TurnGateStore();

  // Step 1: begin() — turn dispatched
  const scopeKey = gate.begin("binding-1", "/workspace");
  assert.equal(gate.isPending("binding-1", "/workspace"), true);

  // Step 2: runtime.turn.completed fires before sendTurn() resolves.
  // attachThread() has NOT been called yet.
  // releaseThread() finds nothing and returns without clearing the scope.
  gate.releaseThread("thread-abc");   // no-op — scopeByThreadId is empty
  assert.equal(gate.isPending("binding-1", "/workspace"), true, "releaseThread alone does not clear scope before attachThread");

  // Step 3: fallback releaseScope (what app.js now does after the fix)
  gate.releaseScope("binding-1", "/workspace");
  assert.equal(gate.isPending("binding-1", "/workspace"), false, "releaseScope clears the pending scope");

  // Step 4: sendTurn() eventually resolves — dispatchPreparedTurn calls attachThread.
  // attachThread must be a no-op because the scope is no longer pending.
  gate.attachThread(scopeKey, "thread-abc");

  // Verify: no stale scopeByThreadId entry was created
  gate.releaseThread("thread-abc");   // should not corrupt any other scope
  assert.equal(gate.isPending("binding-1", "/workspace"), false, "no stale entry after late attachThread");
});

test("AGY race: failed terminal event before attachThread — isPending is cleared", () => {
  const gate = new TurnGateStore();
  gate.begin("binding-2", "/ws2");
  assert.equal(gate.isPending("binding-2", "/ws2"), true);

  // Simulate failed terminal event arriving before attachThread
  gate.releaseThread("thread-xyz");                // no-op
  gate.releaseScope("binding-2", "/ws2");          // fallback path
  assert.equal(gate.isPending("binding-2", "/ws2"), false);

  // Late attachThread must not re-introduce a pending entry
  gate.attachThread("binding-2::/ws2", "thread-xyz");
  assert.equal(gate.isPending("binding-2", "/ws2"), false);
});

test("AGY race: handleRuntimeEvent releases scope via fallback when terminal event precedes attachThread", async () => {
  // Simulate the exact production sequence:
  // 1. turnGateStore.begin() is called
  // 2. runtime.turn.completed fires (handleRuntimeEvent called)
  //    → releaseThread finds nothing (attachThread not yet called)
  //    → fallback releaseScope fires
  // 3. sendTurn() Promise resolves → attachThread called (must be no-op)
  // 4. Second message arrives → isPending must be false → dispatch, not buffer

  const gate = new TurnGateStore();
  const pendingScopeKey = gate.begin("binding-1", "/workspace");
  assert.equal(gate.isPending("binding-1", "/workspace"), true);

  const dispatchedTurns = [];

  // Build a minimal app-like object that mirrors the production flow.
  // SessionStore already has the threadId→binding mapping because index.js
  // calls setThreadIdForWorkspace before emitting runtime events.
  const appLike = {
    turnGateStore: gate,
    turnBoundaryScopeKeys: new Set(),
    streamDelivery: {
      async handleRuntimeEvent() {},
      resolveReplyTargetForRun() { return null; },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId(threadId) {
            if (threadId === "thread-1") {
              return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
            }
            return null;
          },
        };
      },
    },
    pendingOperationByRunKey: new Map(),
    hasPendingInboundMessage() { return false; },
    async sendFailureToThread() {},
    async stopTypingForThread() {},
    async flushPendingInboundMessages() {
      // When flushing, simulate dispatching the buffered second message
    },
    async flushPendingSystemMessages() {},
  };

  // --- Step 2: handleRuntimeEvent called BEFORE attachThread ---
  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1", text: "ok" },
  });

  // After the event: scope must already be released
  assert.equal(gate.isPending("binding-1", "/workspace"), false,
    "isPending must be false immediately after terminal event (before attachThread)");

  // --- Step 3: sendTurn() resolves — dispatchPreparedTurn calls attachThread ---
  gate.attachThread(pendingScopeKey, "thread-1");

  // Must still be false — attachThread must be a no-op when scope is released
  assert.equal(gate.isPending("binding-1", "/workspace"), false,
    "isPending must remain false after late attachThread");

  // --- Step 4: Verify second message is not gated ---
  const isTurnDispatchBlockedFn = CyberbossApp.prototype.isTurnDispatchBlocked;
  const appLike2 = {
    turnGateStore: gate,
    turnBoundaryScopeKeys: new Set(),
    runtimeAdapter: {
      getSessionStore() {
        return {
          getThreadIdForWorkspace() { return null; },
        };
      },
    },
    threadStateStore: {
      getThreadState() { return null; },
    },
  };
  const blocked = isTurnDispatchBlockedFn.call(appLike2, "binding-1", "/workspace");
  assert.equal(blocked, false,
    "second message must not be blocked after first turn completes via fallback path");
});

test("AGY race: second consecutive message is dispatched (not buffered) after first turn", async () => {
  // End-to-end flow: first turn completes via race path, second message dispatches.
  const gate = new TurnGateStore();
  gate.begin("binding-1", "/workspace");

  // Simulate terminal event arriving before attachThread
  gate.releaseThread("thread-1");       // no-op
  gate.releaseScope("binding-1", "/workspace");  // fallback
  gate.attachThread("binding-1::/workspace", "thread-1");  // late — must be no-op

  assert.equal(gate.isPending("binding-1", "/workspace"), false,
    "gate must be open for second message");

  // Confirm scopeByThreadId has no stale entry by doing a fresh begin+attach
  const scopeKey2 = gate.begin("binding-1", "/workspace");
  gate.attachThread(scopeKey2, "thread-2");
  assert.equal(gate.isPending("binding-1", "/workspace"), true,
    "new turn can acquire the gate normally");
  gate.releaseThread("thread-2");
  assert.equal(gate.isPending("binding-1", "/workspace"), false,
    "new turn releases cleanly via normal path");
});

test("normal path (attachThread before releaseThread) still works after fix", () => {
  // Ensure the guard in attachThread does not break the common case
  const gate = new TurnGateStore();
  const scopeKey = gate.begin("binding-3", "/ws3");

  // Normal: attachThread called while scope is still pending
  gate.attachThread(scopeKey, "thread-3");
  assert.equal(gate.isPending("binding-3", "/ws3"), true);

  // Normal: releaseThread clears the scope
  gate.releaseThread("thread-3");
  assert.equal(gate.isPending("binding-3", "/ws3"), false);
});

