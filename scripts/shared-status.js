const http = require("http");
const { execFile } = require("child_process");
const {
  listenUrl,
  appServerPidFile,
  bridgePidFile,
  readPidFile,
  isPidAlive,
} = require("./shared-common");

async function main() {
  const runtime = process.env.CYBERBOSS_RUNTIME || "codex";
  const isCodex = runtime === "codex";
  console.log(`runtime=${runtime}`);
  console.log(`listen=${listenUrl}`);
  printPidState("shared_app_server_pid", appServerPidFile);
  printPidState("shared_cyberboss_pid", bridgePidFile);
  if (!isCodex) {
    console.log(`readyz=skipped`);
    if (runtime === "qoder") console.log(`qoder_cli=${await checkQoderCli() ? "available" : "unavailable"}`);
  } else {
    console.log(`readyz=${await checkReadyz() ? "ok" : "down"}`);
  }
}

function checkQoderCli() {
  return new Promise((resolve) => {
    execFile(process.env.CYBERBOSS_QODER_COMMAND || "qoder", ["--version"],
      { timeout: 5000 }, (error, stdout) => resolve(!error && !!String(stdout).trim()));
  });
}

function printPidState(label, filePath) {
  const pid = readPidFile(filePath);
  if (!pid) {
    console.log(`${label}=missing`);
    return;
  }
  if (!isPidAlive(pid)) {
    console.log(`${label}=stale`);
    return;
  }
  console.log(`${label}=${pid}`);
}

function checkReadyz() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: new URL(listenUrl).port,
        path: "/readyz",
        timeout: 600,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
