// Installs a pinned upstream binary; does not start services or run tests.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("此安装入口目前支持 Windows x64");
  const dir = path.resolve(__dirname, "../third_party/opentodo/v1.4.2");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opentodo-windows-amd64.exe");
  const expected = "5b3b900592d0c61dddd81aec748900daf95f72903d2ed5b358a593f610fb861e";
  if (fs.existsSync(file)) {
    if (crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === expected) {
      console.log("OpenTodo v1.4.2 已安装。"); return;
    }
    throw new Error("已有二进制与锁定版本不符；不会覆盖，请保留后人工处理");
  }
  const response = await fetch("https://github.com/OpenTodoApp/OpenTodo/releases/download/v1.4.2/opentodo-windows-amd64.exe", { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const binary = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash("sha256").update(binary).digest("hex") !== expected) throw new Error("下载完整性校验不匹配，未安装");
  fs.writeFileSync(file, binary, { flag: "wx" });
  console.log("已安装 OpenTodo v1.4.2；尚未启动服务。");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
