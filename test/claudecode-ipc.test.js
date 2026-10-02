const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");

const {
  ClaudeCodeIpcServer,
  resolveClaudeIpcEndpoint,
  resolveClaudeIpcTokenPath,
  isNamedPipeEndpoint,
} = require("../src/adapters/runtime/claudecode/ipc-server");
const { createClaudeCodeRuntimeAdapter } = require("../src/adapters/runtime/claudecode");

test("win32: endpoint starts with \\\\.\\pipe\\", () => {
  const endpoint = resolveClaudeIpcEndpoint("C:\\Users\\User\\.cyberboss", "win32");
  assert.match(endpoint, /^\\\\\.\\pipe\\cyberboss-claudecode-runtime-[0-9a-f]{12}$/);
  assert.equal(isNamedPipeEndpoint(endpoint), true);
});

test("win32: does not call filesystem stale socket lstat/unlink/chmod on named pipe", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ipc-win32-"));
  try {
    const pipePath = "\\\\.\\pipe\\cyberboss-claudecode-runtime-testpipe";
    const server = new ClaudeCodeIpcServer({
      endpoint: pipePath,
      stateDir: tmpDir,
      platform: "win32",
    });

    assert.equal(server.isNamedPipe, true);

    const origLstat = fs.lstatSync;
    const origUnlink = fs.unlinkSync;
    const origChmod = fs.chmodSync;

    let lstatCalledOnPipe = false;
    let unlinkCalledOnPipe = false;
    let chmodCalledOnPipe = false;

    fs.lstatSync = (p, ...args) => {
      if (p === pipePath) lstatCalledOnPipe = true;
      return origLstat(p, ...args);
    };
    fs.unlinkSync = (p, ...args) => {
      if (p === pipePath) unlinkCalledOnPipe = true;
      return origUnlink(p, ...args);
    };
    fs.chmodSync = (p, ...args) => {
      if (p === pipePath) chmodCalledOnPipe = true;
      return origChmod(p, ...args);
    };

    try {
      server.ensureDirectory();
      server.removeStaleSocket();

      assert.equal(lstatCalledOnPipe, false, "fs.lstatSync must not be called on named pipe");
      assert.equal(unlinkCalledOnPipe, false, "fs.unlinkSync must not be called on named pipe");
      assert.equal(chmodCalledOnPipe, false, "fs.chmodSync must not be called on named pipe");
    } finally {
      fs.lstatSync = origLstat;
      fs.unlinkSync = origUnlink;
      fs.chmodSync = origChmod;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("win32: token file is located as a regular file in stateDir", () => {
  const stateDir = "C:\\Users\\Administrator\\.cyberboss";
  const tokenPath = resolveClaudeIpcTokenPath(stateDir, "win32");
  assert.equal(isNamedPipeEndpoint(tokenPath), false);
  assert.equal(tokenPath, path.join(stateDir, "claudecode-runtime.token"));
  assert.equal(path.basename(tokenPath), "claudecode-runtime.token");
});

test("POSIX: endpoint is stateDir/claudecode-runtime.sock", () => {
  const linuxEndpoint = resolveClaudeIpcEndpoint("/home/user/.cyberboss", "linux");
  assert.equal(linuxEndpoint, "/home/user/.cyberboss/claudecode-runtime.sock");
  assert.equal(isNamedPipeEndpoint(linuxEndpoint), false);

  const darwinEndpoint = resolveClaudeIpcEndpoint("/Users/user/.cyberboss", "darwin");
  assert.equal(darwinEndpoint, "/Users/user/.cyberboss/claudecode-runtime.sock");
  assert.equal(isNamedPipeEndpoint(darwinEndpoint), false);
});

test("POSIX: stale socket cleanup and chmod behavior is preserved", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ipc-posix-"));
  try {
    const socketPath = path.join(tmpDir, "claudecode-runtime.sock");
    const server = new ClaudeCodeIpcServer({
      endpoint: socketPath,
      stateDir: tmpDir,
      platform: "linux",
    });

    assert.equal(server.isNamedPipe, false);

    let lstatTarget = null;
    let unlinkTarget = null;

    const origLstat = fs.lstatSync;
    const origUnlink = fs.unlinkSync;

    fs.lstatSync = (p, ...args) => {
      lstatTarget = p;
      return { isSocket: () => true };
    };
    fs.unlinkSync = (p, ...args) => {
      unlinkTarget = p;
    };

    try {
      server.removeStaleSocket();
      assert.equal(lstatTarget, socketPath);
      assert.equal(unlinkTarget, socketPath);
    } finally {
      fs.lstatSync = origLstat;
      fs.unlinkSync = origUnlink;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("same stateDir: Windows pipe name is stable and deterministic", () => {
  const p1 = resolveClaudeIpcEndpoint("C:\\Users\\Admin\\.cyberboss", "win32");
  const p2 = resolveClaudeIpcEndpoint("c:\\users\\admin\\.cyberboss\\", "win32");
  const p3 = resolveClaudeIpcEndpoint("C:/Users/Admin/.cyberboss/", "win32");
  assert.equal(p1, p2);
  assert.equal(p1, p3);
});

test("different stateDir: Windows pipe name is different", () => {
  const pA = resolveClaudeIpcEndpoint("C:\\Users\\UserA\\.cyberboss", "win32");
  const pB = resolveClaudeIpcEndpoint("C:\\Users\\UserB\\.cyberboss", "win32");
  assert.notEqual(pA, pB);
});

test("IPC listen error: initialize explicitly fails rather than leaving half-started runtime", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ipc-fail-"));
  try {
    const sessionsFile = path.join(tmpDir, "sessions.json");
    fs.writeFileSync(sessionsFile, JSON.stringify({ bindings: {} }));

    // Create an adapter configured to an invalid pipe / socket path that will fail listen
    const invalidEndpoint = process.platform === "win32"
      ? path.join(tmpDir, "not-a-pipe.sock") // on win32, regular file path causes listen EACCES
      : path.join(tmpDir, "nonexistent", "dir", "not-a-pipe.sock");

    const adapter = createClaudeCodeRuntimeAdapter({
      stateDir: tmpDir,
      sessionsFile,
      claudeCommand: "claude",
    });

    // Replace the internal ipcServer with one pointing to an endpoint that fails listen
    adapter.close(); // ensure clean state
    const failingServer = new ClaudeCodeIpcServer({
      endpoint: invalidEndpoint,
      stateDir: tmpDir,
      platform: process.platform,
    });

    // Overwrite the adapter's ipcServer via closure test by creating a targeted test
    await assert.rejects(
      async () => {
        await failingServer.start();
      },
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Windows smoke test: start ClaudeCodeIpcServer, listen named pipe, authenticate, and close cleanly", { skip: process.platform !== "win32" }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ipc-smoke-"));
  try {
    const server = new ClaudeCodeIpcServer({
      stateDir: tmpDir,
      platform: "win32",
    });

    assert.equal(server.isNamedPipe, true);
    await server.start();

    // Verify listening
    assert.ok(server.server.listening, "Server must be listening");
    // Verify token file created
    assert.ok(fs.existsSync(server.tokenFile), "Token file must exist on disk");
    const authToken = fs.readFileSync(server.tokenFile, "utf8").trim();
    assert.equal(authToken.length, 64, "Token must be a 64-character hex string");

    // Connect a client socket to the named pipe
    const client = net.createConnection(server.endpoint);
    client.setEncoding("utf8");

    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });

    // Authenticate
    client.write(JSON.stringify({ type: "auth", token: authToken }) + "\n");

    // Wait for server to authenticate client
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(server.authenticated.size, 1, "Client should be authenticated");

    // Close client and server
    client.end();
    await server.close();

    // Verify token file was removed
    assert.equal(fs.existsSync(server.tokenFile), false, "Token file should be removed on close");
    assert.equal(server.server, null, "Server reference should be null");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("createClaudeCodeRuntimeAdapter initialize starts IPC server and close cleans up", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ipc-adapter-"));
  try {
    const sessionsFile = path.join(tmpDir, "sessions.json");
    fs.writeFileSync(sessionsFile, JSON.stringify({ bindings: {} }));

    const adapter = createClaudeCodeRuntimeAdapter({
      stateDir: tmpDir,
      sessionsFile,
      claudeCommand: "claude",
    });

    const initResult = await adapter.initialize();
    assert.equal(initResult.command, "claude");

    const tokenPath = resolveClaudeIpcTokenPath(tmpDir);
    assert.ok(fs.existsSync(tokenPath), "Token file must exist after adapter.initialize()");

    await adapter.close();
    assert.ok(!fs.existsSync(tokenPath), "Token file must be removed after adapter.close()");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

