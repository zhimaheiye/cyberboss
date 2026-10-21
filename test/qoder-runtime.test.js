const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { QoderProcessClient } = require("../src/adapters/runtime/qoder/process-client");
const { createQoderRuntimeAdapter } = require("../src/adapters/runtime/qoder");
const { SessionStore } = require("../src/adapters/runtime/codex/session-store");

const ID = "12345678-1234-4234-8234-123456789abc";
function fixture(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-qoder-test-"));
  const command = path.join(dir, "qoder-mock");
  fs.writeFileSync(command, `#!${process.execPath}\n` + String.raw`
const mode = process.env.QODER_MOCK_MODE;
const id = "12345678-1234-4234-8234-123456789abc";
let prompt="";
process.stdin.on("data", x => prompt += x);
process.stdin.on("end", () => {
  if (mode === "timeout") { setInterval(() => {}, 1000); return; }
  if (mode === "malformed") { process.stdout.write("{bad\n"); return; }
  if (mode === "failure") { process.stdout.write(JSON.stringify({type:"result",subtype:"error",is_error:true,session_id:id,result:"bad"})+"\n"); return; }
  if (mode === "exit") { process.stderr.write("secret stderr"); process.exitCode=2; return; }
  const resumed = process.argv.includes("--resume") && process.argv.includes(id);
  const response = resumed ? "resumed" : prompt.includes("hello") ? "hello back" : "other";
  process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:id})+"\n");
  process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"thinking",thinking:"private"}]},session_id:id})+"\n");
  const result = JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:id,result:response});
  process.stdout.write(result.slice(0,10));
  setTimeout(() => {
    process.stdout.write(result.slice(10)+"\n");
    if (mode === "duplicate") process.stdout.write(result+"\n");
  }, 5);
});
`);
  fs.chmodSync(command, 0o700);
  return { dir, command, env: { ...process.env, QODER_MOCK_MODE: mode } };
}

test("Qoder parses split JSONL and only returns final text, then resumes scoped session", async (t) => {
  const f = fixture("success"); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const client = new QoderProcessClient({ command: f.command, cwd: f.dir, env: f.env });
  const first = await client.runTurn({ text: "hello", model: "Qwen3.8-Flash" });
  assert.deepEqual({ sessionId: first.sessionId, text: first.text }, { sessionId: ID, text: "hello back" });
  const second = await client.runTurn({ text: "continue", sessionId: ID });
  assert.equal(second.text, "resumed");
});

for (const mode of ["malformed", "failure", "exit", "duplicate", "timeout"]) {
  test(`Qoder rejects ${mode} without returning a reply`, async (t) => {
    const f = fixture(mode); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
    const client = new QoderProcessClient({ command: f.command, cwd: f.dir, env: f.env, timeoutMs: 150 });
    await assert.rejects(client.runTurn({ text: "hello" }), mode === "timeout" ? /timed out/ : undefined);
  });
}

test("Qoder cancellation kills the in-flight process", async (t) => {
  const f = fixture("timeout"); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const client = new QoderProcessClient({ command: f.command, cwd: f.dir, env: f.env, timeoutMs: 2000 });
  const pending = client.runTurn({ text: "hello" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await client.cancel();
  await assert.rejects(pending);
});

test("Qoder adapter stores each binding separately and emits one final reply", async (t) => {
  const f = fixture("success"); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const adapter = createQoderRuntimeAdapter({ sessionsFile: path.join(f.dir, "sessions.json"), qoderCommand: f.command,
    qoderModel: "Qwen3.8-Flash", qoderTimeoutMs: 1000, userName: "Test" });
  // The mock intentionally returns the same ID; a real Qoder session ID is generated per new session.
  const events = []; adapter.onEvent((event) => events.push(event));
  await adapter.sendTurn({ bindingKey: "sender-one", workspaceRoot: f.dir, text: "hello" });
  assert.equal(events.filter((event) => event.type === "runtime.reply.completed").length, 1);
  assert.equal(events.find((event) => event.type === "runtime.reply.completed").payload.text, "hello back");
  assert.equal(adapter.getSessionStore().getThreadIdForWorkspace("sender-one", f.dir), ID);
  assert.equal(adapter.getSessionStore().getThreadIdForWorkspace("sender-two", f.dir), "");
  await adapter.close();
});

test("Qoder model catalog is separate from Codex catalog", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-model-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "sessions.json");
  const codex = new SessionStore({ filePath, runtimeId: "codex" });
  codex.setAvailableModelCatalog([{ model: "codex-model" }]);
  const qoder = new SessionStore({ filePath, runtimeId: "qoder" });
  assert.equal(qoder.getAvailableModelCatalog(), null);
  qoder.setAvailableModelCatalog([{ model: "Qwen3.8-Flash" }]);
  assert.equal(new SessionStore({ filePath, runtimeId: "codex" }).getAvailableModelCatalog().models[0].model, "codex-model");
  assert.equal(new SessionStore({ filePath, runtimeId: "qoder" }).getAvailableModelCatalog().models[0].model, "Qwen3.8-Flash");
});
