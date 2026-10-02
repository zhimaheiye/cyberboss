const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const {
  ClaudeCodeProcessClient,
  resolveClaudeCommand,
  prepareClaudeSpawn,
  quoteCmdArg,
} = require("../src/adapters/runtime/claudecode/process-client");
const { mapClaudeCodeMessageToRuntimeEvent } = require("../src/adapters/runtime/claudecode/events");

test("win32: command=claude, PATH only has claude.cmd -> resolves cmd shim", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-claude-shim-"));
  try {
    const shimPath = path.join(tmpDir, "claude.cmd");
    fs.writeFileSync(shimPath, "@echo off\r\n");

    const resolved = resolveClaudeCommand({
      command: "claude",
      env: {
        PATH: tmpDir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
      platform: "win32",
    });

    assert.equal(resolved.resolvedPath.toLowerCase(), path.resolve(shimPath).toLowerCase());
    assert.equal(resolved.isBatch, true);
    assert.equal(resolved.isExe, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("win32: absolute xxx\\claude.cmd -> uses ComSpec", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-claude-abs-"));
  try {
    const shimPath = path.join(tmpDir, "claude.cmd");
    fs.writeFileSync(shimPath, "@echo off\r\n");

    const comspec = "C:\\Windows\\system32\\cmd.exe";
    const target = prepareClaudeSpawn({
      command: shimPath,
      args: ["--version"],
      env: { ComSpec: comspec },
      platform: "win32",
    });

    assert.equal(target.spawnCommand, comspec);
    assert.equal(target.spawnArgs[0], "/d");
    assert.equal(target.spawnArgs[1], "/s");
    assert.equal(target.spawnArgs[2], "/c");
    assert.match(target.spawnArgs[3], new RegExp(path.basename(shimPath)));
    assert.equal(target.spawnOptions.windowsVerbatimArguments, true);
    assert.equal(target.spawnOptions.shell, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("win32: xxx.exe -> directly spawn, no cmd", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-claude-exe-"));
  try {
    const exePath = path.join(tmpDir, "claude.exe");
    fs.writeFileSync(exePath, "dummy");

    const target = prepareClaudeSpawn({
      command: exePath,
      args: ["--version"],
      platform: "win32",
    });

    assert.equal(target.spawnCommand.toLowerCase(), path.resolve(exePath).toLowerCase());
    assert.deepEqual(target.spawnArgs, ["--version"]);
    assert.equal(target.spawnOptions.shell, false);
    assert.equal(target.spawnOptions.windowsVerbatimArguments, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("command not found -> explicit command-not-found error", () => {
  assert.throws(
    () => {
      resolveClaudeCommand({
        command: "nonexistent-claude-tool-xyz",
        env: { PATH: "" },
        platform: "win32",
      });
    },
    {
      name: "Error",
      message: "Claude Code command not found: nonexistent-claude-tool-xyz",
    }
  );

  assert.throws(
    () => {
      prepareClaudeSpawn({
        command: "nonexistent-claude-tool-xyz",
        env: { PATH: "" },
        platform: "win32",
      });
    },
    {
      name: "Error",
      message: "Claude Code command not found: nonexistent-claude-tool-xyz",
    }
  );
});

test("POSIX command=claude -> preserves direct spawn", () => {
  const target = prepareClaudeSpawn({
    command: "claude",
    args: ["--version"],
    platform: "linux",
  });

  assert.equal(target.spawnCommand, "claude");
  assert.deepEqual(target.spawnArgs, ["--version"]);
  assert.equal(target.spawnOptions.shell, false);

  const targetDarwin = prepareClaudeSpawn({
    command: "/usr/local/bin/claude",
    args: ["--output-format", "stream-json"],
    platform: "darwin",
  });

  assert.equal(targetDarwin.spawnCommand, "/usr/local/bin/claude");
  assert.deepEqual(targetDarwin.spawnArgs, ["--output-format", "stream-json"]);
  assert.equal(targetDarwin.spawnOptions.shell, false);
});

test("Windows shim: stdin/stdout/stderr pipe is functional", { skip: process.platform !== "win32" }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-pipe-test-"));
  try {
    const nodeScript = path.join(tmpDir, "echo.js");
    fs.writeFileSync(nodeScript, `
      const readline = require("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.on("line", (line) => {
        if (line === "EXIT") process.exit(0);
        process.stdout.write("ECHO:" + line + "\\n");
      });
    `);

    const batFile = path.join(tmpDir, "echo.bat");
    fs.writeFileSync(batFile, `@echo off\r\nnode "${nodeScript}" %*\r\n`);

    const target = prepareClaudeSpawn({
      command: batFile,
      args: [],
      platform: "win32",
    });

    const child = spawn(target.spawnCommand, target.spawnArgs, {
      ...target.spawnOptions,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let received = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) received.push(line.trim());
      }
    });

    child.stdin.write("hello-pipe\n");
    await new Promise((r) => setTimeout(r, 100));

    child.stdin.write("EXIT\n");
    await new Promise((resolve) => child.on("close", resolve));

    assert.ok(received.includes("ECHO:hello-pipe"), "Must receive echoed message via pipe");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("args with space path (d:\\some path\\.mcp.json) -> argument is not broken", { skip: process.platform !== "win32" }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-args-space-"));
  try {
    const inspectScript = path.join(tmpDir, "inspect.js");
    fs.writeFileSync(inspectScript, `
      process.stdout.write(JSON.stringify(process.argv.slice(2)));
    `);

    const batFile = path.join(tmpDir, "inspect.bat");
    fs.writeFileSync(batFile, `@echo off\r\nnode "${inspectScript}" %*\r\n`);

    const testArgs = [
      "--mcp-config",
      "d:\\some path with spaces\\.mcp.json",
      "--resume",
      "162302a5-d7e1-4789-876d-efab34493732",
    ];

    const target = prepareClaudeSpawn({
      command: batFile,
      args: testArgs,
      platform: "win32",
    });

    const child = spawn(target.spawnCommand, target.spawnArgs, {
      ...target.spawnOptions,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (d) => output += d.toString());
    await new Promise((resolve) => child.on("close", resolve));

    const parsed = JSON.parse(output.trim());
    assert.deepEqual(parsed, testArgs);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resume session / mcp config args -> not corrupted by escaping", { skip: process.platform !== "win32" }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-args-corrupt-"));
  try {
    const inspectScript = path.join(tmpDir, "inspect.js");
    fs.writeFileSync(inspectScript, `
      process.stdout.write(JSON.stringify(process.argv.slice(2)));
    `);

    const batFile = path.join(tmpDir, "inspect.cmd");
    fs.writeFileSync(batFile, `@echo off\r\nnode "${inspectScript}" %*\r\n`);

    const testArgs = [
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--permission-prompt-tool", "stdio",
      "--verbose",
      "--resume", "01a01f1e-3b44-7d50-bc7f-407dcf15f242",
      "--model", "deepseek-v4-flash",
      "--mcp-config", "C:\\Users\\User\\.cyberboss\\.mcp.json",
      "--extra", '{"key":"value with spaces and \\"quotes\\""}',
    ];

    const target = prepareClaudeSpawn({
      command: batFile,
      args: testArgs,
      platform: "win32",
    });

    const child = spawn(target.spawnCommand, target.spawnArgs, {
      ...target.spawnOptions,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (d) => output += d.toString());
    await new Promise((resolve) => child.on("close", resolve));

    const parsed = JSON.parse(output.trim());
    assert.deepEqual(parsed, testArgs);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ClaudeCodeProcessClient rejects and emits process.error on missing command", async () => {
  const client = new ClaudeCodeProcessClient({
    command: "nonexistent-cmd-abc-123",
    cwd: process.cwd(),
  });

  let emittedError = null;
  client.onMessage((event) => {
    if (event?.type === "process.error") {
      emittedError = event.error;
    }
  });

  await assert.rejects(
    async () => {
      await client.connect();
    },
    /Claude Code command not found: nonexistent-cmd-abc-123/
  );

  assert.match(emittedError, /Claude Code command not found/);
});

test("Windows machine verification: resolveClaudeCommand resolves current claude command", { skip: process.platform !== "win32" }, () => {
  const resolved = resolveClaudeCommand({ command: "claude" });
  assert.equal(resolved.isBatch, true);
  assert.match(resolved.resolvedPath, /claude\.cmd$/i);
  assert.ok(fs.existsSync(resolved.resolvedPath));
});

function createFakeClaudeScript(tmpDir, scriptBody) {
  const isWin = process.platform === "win32";
  const nodeScript = path.join(tmpDir, "fake.js");
  fs.writeFileSync(nodeScript, scriptBody);
  const scriptFile = isWin ? path.join(tmpDir, "fake.cmd") : path.join(tmpDir, "fake.sh");
  if (isWin) {
    fs.writeFileSync(scriptFile, `@echo off\r\nnode "${nodeScript}" %*\r\n`);
  } else {
    fs.writeFileSync(scriptFile, `#!/bin/sh\nnode "${nodeScript}" "$@"\n`);
    fs.chmodSync(scriptFile, 0o755);
  }
  return scriptFile;
}

test("lifecycle 1: turn started -> valid result -> process exit code 0 -> turn.completed, no runtime.turn.failed", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-life-1-"));
  try {
    const scriptFile = createFakeClaudeScript(tmpDir, `
      const readline = require("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      process.stdout.write(JSON.stringify({ type: "system", session_id: "00000000-0000-4000-8000-000000000001" }) + "\\n");
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "user") {
          process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok reply" }] } }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "result", session_id: "00000000-0000-4000-8000-000000000001", result: "ok reply" }) + "\\n");
          setTimeout(() => process.exit(0), 50);
        }
      });
    `);

    const client = new ClaudeCodeProcessClient({
      command: scriptFile,
      cwd: tmpDir,
    });

    const clientEvents = [];
    const runtimeEvents = [];
    client.onMessage((event, raw) => {
      clientEvents.push(event);
      const mapped = mapClaudeCodeMessageToRuntimeEvent(event, raw);
      if (mapped) runtimeEvents.push(mapped);
    });

    await client.connect();
    await client.waitForSessionId();
    await client.sendUserMessage({ text: "hi", threadId: "00000000-0000-4000-8000-000000000001" });

    await new Promise((resolve) => setTimeout(resolve, 300));

    const completedEvent = clientEvents.find((e) => e.type === "turn.completed");
    assert.ok(completedEvent, "Must emit turn.completed");
    assert.equal(completedEvent.text, "ok reply");

    const exitEvent = clientEvents.find((e) => e.type === "process.exit");
    assert.ok(exitEvent, "Must emit process.exit");
    assert.equal(exitEvent.code, 0);

    const closeEvent = clientEvents.find((e) => e.type === "process.close");
    assert.equal(closeEvent, undefined, "Must NOT emit process.close on completed turn");

    assert.ok(runtimeEvents.some((e) => e.type === "runtime.turn.completed"));
    assert.equal(runtimeEvents.some((e) => e.type === "runtime.turn.failed"), false, "Must NOT have runtime.turn.failed");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("lifecycle 2: turn started -> valid result -> process exit code 1 -> completed reply not marked as failed", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-life-2-"));
  try {
    const scriptFile = createFakeClaudeScript(tmpDir, `
      const readline = require("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      process.stdout.write(JSON.stringify({ type: "system", session_id: "00000000-0000-4000-8000-000000000002" }) + "\\n");
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "user") {
          process.stdout.write(JSON.stringify({ type: "result", session_id: "00000000-0000-4000-8000-000000000002", result: "done reply" }) + "\\n");
          setTimeout(() => process.exit(1), 50);
        }
      });
    `);

    const client = new ClaudeCodeProcessClient({
      command: scriptFile,
      cwd: tmpDir,
    });

    const clientEvents = [];
    const runtimeEvents = [];
    client.onMessage((event, raw) => {
      clientEvents.push(event);
      const mapped = mapClaudeCodeMessageToRuntimeEvent(event, raw);
      if (mapped) runtimeEvents.push(mapped);
    });

    await client.connect();
    await client.waitForSessionId();
    await client.sendUserMessage({ text: "hi", threadId: "00000000-0000-4000-8000-000000000002" });

    await new Promise((resolve) => setTimeout(resolve, 300));

    const completedEvent = clientEvents.find((e) => e.type === "turn.completed");
    assert.ok(completedEvent, "Must emit turn.completed");

    const exitEvent = clientEvents.find((e) => e.type === "process.exit");
    assert.ok(exitEvent, "Must emit process.exit");
    assert.equal(exitEvent.code, 1);

    const closeEvent = clientEvents.find((e) => e.type === "process.close");
    assert.equal(closeEvent, undefined, "Must NOT emit process.close when turn completed");

    assert.equal(runtimeEvents.some((e) => e.type === "runtime.turn.failed"), false, "Must NOT produce user turn failure");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("lifecycle 3: turn started -> no result -> process exit code 1 -> must emit runtime.turn.failed", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-life-3-"));
  try {
    const scriptFile = createFakeClaudeScript(tmpDir, `
      const readline = require("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      process.stdout.write(JSON.stringify({ type: "system", session_id: "00000000-0000-4000-8000-000000000003" }) + "\\n");
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "user") {
          setTimeout(() => process.exit(1), 50);
        }
      });
    `);

    const client = new ClaudeCodeProcessClient({
      command: scriptFile,
      cwd: tmpDir,
    });

    const clientEvents = [];
    const runtimeEvents = [];
    client.onMessage((event, raw) => {
      clientEvents.push(event);
      const mapped = mapClaudeCodeMessageToRuntimeEvent(event, raw);
      if (mapped) runtimeEvents.push(mapped);
    });

    await client.connect();
    await client.waitForSessionId();
    await client.sendUserMessage({ text: "hi", threadId: "00000000-0000-4000-8000-000000000003" });

    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(clientEvents.some((e) => e.type === "turn.completed"), false);

    const closeEvent = clientEvents.find((e) => e.type === "process.close");
    assert.ok(closeEvent, "Must emit process.close on uncompleted turn");
    assert.equal(closeEvent.code, 1);
    assert.ok(closeEvent.turnId, "Must include pending turnId");

    const failedEvent = runtimeEvents.find((e) => e.type === "runtime.turn.failed");
    assert.ok(failedEvent, "Must produce runtime.turn.failed");
    assert.match(failedEvent.payload.text, /Runtime process exited unexpectedly/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("lifecycle 4: process error during pending turn -> must produce failure", async () => {
  const client = new ClaudeCodeProcessClient({
    command: "claude",
    cwd: "/workspace",
  });
  client.alive = true;
  client.stdin = { write: () => {} };
  client.sessionId = "00000000-0000-4000-8000-000000000004";

  const clientEvents = [];
  const runtimeEvents = [];
  client.onMessage((event, raw) => {
    clientEvents.push(event);
    const mapped = mapClaudeCodeMessageToRuntimeEvent(event, raw);
    if (mapped) runtimeEvents.push(mapped);
  });

  await client.sendUserMessage({ text: "hi", threadId: "00000000-0000-4000-8000-000000000004" });
  const turnId = client.pendingTurnId;
  assert.ok(turnId);

  // Trigger error event as child.on("error") would
  client.rejectSessionWaiters(new Error("IO error occurred"));
  client.alive = false;
  client.child = null;
  client.stdin = null;
  client.pendingTurnId = "";
  client.emit({
    type: "process.error",
    error: "IO error occurred",
    sessionId: client.sessionId,
    turnId,
  }, null);

  const errorEvent = clientEvents.find((e) => e.type === "process.error");
  assert.ok(errorEvent);
  assert.equal(errorEvent.turnId, turnId);

  const failedEvent = runtimeEvents.find((e) => e.type === "runtime.turn.failed");
  assert.ok(failedEvent);
  assert.equal(failedEvent.payload.text, "IO error occurred");
  assert.equal(failedEvent.payload.turnId, turnId);
});

test("lifecycle 5: successful turn then process close -> client alive=false, child=null, stdin=null", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-life-5-"));
  try {
    const scriptFile = createFakeClaudeScript(tmpDir, `
      const readline = require("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      process.stdout.write(JSON.stringify({ type: "system", session_id: "00000000-0000-4000-8000-000000000005" }) + "\\n");
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "user") {
          process.stdout.write(JSON.stringify({ type: "result", session_id: "00000000-0000-4000-8000-000000000005", result: "all good" }) + "\\n");
          setTimeout(() => process.exit(0), 50);
        }
      });
    `);

    const client = new ClaudeCodeProcessClient({
      command: scriptFile,
      cwd: tmpDir,
    });

    await client.connect();
    assert.equal(client.alive, true);
    assert.ok(client.child);
    assert.ok(client.stdin);

    await client.waitForSessionId();
    await client.sendUserMessage({ text: "hi", threadId: "00000000-0000-4000-8000-000000000005" });

    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(client.alive, false, "client.alive must be false after process exit");
    assert.equal(client.child, null, "client.child must be null");
    assert.equal(client.stdin, null, "client.stdin must be null");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("lifecycle 6: next turn after process close -> can reconnect and resume session correctly", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-life-6-"));
  try {
    const logFile = path.join(tmpDir, "spawns.log");
    const scriptFile = createFakeClaudeScript(tmpDir, `
      const fs = require("fs");
      const readline = require("readline");
      fs.appendFileSync(${JSON.stringify(logFile)}, "spawn:" + process.argv.slice(2).join(" ") + "\\n");
      const resumeArgIndex = process.argv.indexOf("--resume");
      const resumeId = resumeArgIndex !== -1 ? process.argv[resumeArgIndex + 1] : "00000000-0000-4000-8000-000000000006";
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      process.stdout.write(JSON.stringify({ type: "system", session_id: resumeId }) + "\\n");
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "user") {
          process.stdout.write(JSON.stringify({ type: "result", session_id: resumeId, result: "reply to: " + msg.message.content }) + "\\n");
          setTimeout(() => process.exit(0), 50);
        }
      });
    `);

    const client = new ClaudeCodeProcessClient({
      command: scriptFile,
      cwd: tmpDir,
    });

    // Turn 1
    await client.connect();
    const sess1 = await client.waitForSessionId();
    assert.equal(sess1, "00000000-0000-4000-8000-000000000006");
    await client.sendUserMessage({ text: "msg1", threadId: sess1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(client.alive, false);

    // Turn 2: reconnect with resumed session id
    await client.connect(sess1);
    assert.equal(client.alive, true);
    assert.equal(client.resumeSessionId, sess1);
    const sess2 = await client.waitForSessionId();
    assert.equal(sess2, sess1);

    const receivedResults = [];
    client.onMessage((event) => {
      if (event.type === "turn.completed") receivedResults.push(event);
    });

    await client.sendUserMessage({ text: "msg2", threadId: sess2 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(receivedResults.length, 1);
    assert.equal(receivedResults[0].text, "reply to: msg2");
    assert.equal(receivedResults[0].sessionId, sess1);

    // Verify second spawn had --resume
    const spawnLog = fs.readFileSync(logFile, "utf8");
    assert.match(spawnLog, /--resume 00000000-0000-4000-8000-000000000006/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("lifecycle 7: idle process close -> does not produce user turn failure", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-life-7-"));
  try {
    const scriptFile = createFakeClaudeScript(tmpDir, `
      process.stdout.write(JSON.stringify({ type: "system", session_id: "00000000-0000-4000-8000-000000000007" }) + "\\n");
      setTimeout(() => process.exit(0), 100);
    `);

    const client = new ClaudeCodeProcessClient({
      command: scriptFile,
      cwd: tmpDir,
    });

    const clientEvents = [];
    const runtimeEvents = [];
    client.onMessage((event, raw) => {
      clientEvents.push(event);
      const mapped = mapClaudeCodeMessageToRuntimeEvent(event, raw);
      if (mapped) runtimeEvents.push(mapped);
    });

    await client.connect();
    await client.waitForSessionId();
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(client.alive, false);
    const closeEvent = clientEvents.find((e) => e.type === "process.close");
    assert.equal(closeEvent, undefined, "Idle close must NOT emit process.close");

    const exitEvent = clientEvents.find((e) => e.type === "process.exit");
    assert.ok(exitEvent, "Must emit process.exit");

    assert.equal(runtimeEvents.some((e) => e.type === "runtime.turn.failed"), false, "Must NOT produce runtime.turn.failed");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

