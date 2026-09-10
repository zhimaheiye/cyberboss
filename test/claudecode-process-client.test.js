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
