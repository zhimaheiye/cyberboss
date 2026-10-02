const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { CyberbossApp } = require("../src/core/app");
const { createAntigravityRuntimeAdapter } = require("../src/adapters/runtime/antigravity");
const { AntigravityProcessClient } = require("../src/adapters/runtime/antigravity/process-client");

const REAL_COMMAND = process.env.CYBERBOSS_ANTIGRAVITY_COMMAND || "antigravity";
const ALLOWED_CODE = "AGY_ALLOWED_8421";
const BLOCKED_CODE = "AGY_BLOCKED_6157";

function createTestImage(targetPath, text) {
  const ps1Script = `param([string]$text, [string]$outPath)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 900, 300
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font("Segoe UI", 48, [System.Drawing.FontStyle]::Bold)
$brush = [System.Drawing.Brushes]::Black
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF 0, 0, 900, 300
$g.DrawString($text, $font, $brush, $rect, $format)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 4)
$g.DrawRectangle($pen, 10, 10, 880, 280)
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`;

  const tmpPs1 = path.join(path.dirname(targetPath), `create-image-${Date.now()}.ps1`);
  fs.writeFileSync(tmpPs1, ps1Script, "utf-8");

  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmpPs1, text, targetPath],
    { encoding: "utf-8" }
  );

  try {
    fs.unlinkSync(tmpPs1);
  } catch {
    // ignore
  }

  if (res.status !== 0 || !fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
    throw new Error(`PowerShell image generation failed for ${targetPath} (exit: ${res.status}): ${res.stderr || res.stdout}`);
  }
}

function testDangerousProductionAudit() {
  console.log("\n==================================================");
  console.log("Checking Production Sources for Dangerous Flag...");
  console.log("==================================================");

  const srcDir = path.resolve(__dirname, "..", "src");

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const content = fs.readFileSync(fullPath, "utf-8");
        assert(
          !content.includes("dangerously-skip-permissions"),
          `Production file ${fullPath} contains dangerously-skip-permissions!`
        );
      }
    }
  }

  scanDir(srcDir);
  console.log("NO_DANGEROUS_PRODUCTION_DEFAULT_PASS");
}

async function runStage5PermissionTests() {
  console.log("==================================================");
  console.log("Running Stage 5: Antigravity Scoped Permissions");
  console.log("==================================================");

  testDangerousProductionAudit();

  const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
  const allowedDir = path.join(stateDir, "inbox", "stage5-permission-test");
  const negativeDir = path.join(stateDir, "stage5-permission-negative");
  const tempWorkspaceRoot = path.join(os.tmpdir(), `cyberboss-stage5-workspace-${Date.now()}`);

  fs.mkdirSync(allowedDir, { recursive: true });
  fs.mkdirSync(negativeDir, { recursive: true });
  fs.mkdirSync(tempWorkspaceRoot, { recursive: true });

  const allowedImagePath = path.join(allowedDir, "allowed.png");
  const negativeImagePath = path.join(negativeDir, "outside.png");

  try {
    // --------------------------------------------------
    // Step 1: Generate Test Images
    // --------------------------------------------------
    createTestImage(allowedImagePath, ALLOWED_CODE);
    createTestImage(negativeImagePath, BLOCKED_CODE);

    assert(!allowedImagePath.includes(ALLOWED_CODE), "Allowed image path must not leak code in filename");
    assert(!negativeImagePath.includes(BLOCKED_CODE), "Negative image path must not leak code in filename");

    console.log(`Created allowed image: ${allowedImagePath} (${fs.statSync(allowedImagePath).size} bytes)`);
    console.log(`Created negative image: ${negativeImagePath} (${fs.statSync(negativeImagePath).size} bytes)`);

    // --------------------------------------------------
    // Step 2: Positive Permission Test (ProcessClient, extraArgs: [])
    // --------------------------------------------------
    console.log("\nTesting Positive Scoped Read (inbox allowed image, extraArgs: [])...");
    const positiveClient = new AntigravityProcessClient({
      command: REAL_COMMAND,
      cwd: tempWorkspaceRoot,
      env: process.env,
      extraArgs: [],
      timeoutMs: 120_000,
    });

    const positiveRawEvents = [];
    positiveClient.onMessage((raw) => positiveRawEvents.push(raw));

    const positivePrompt = `请读取下面 Saved attachments 中的图片，并只回复图片中央看到的测试代码。不要根据文件名猜测。\n\nSaved attachments:\n- [image] ${allowedImagePath}\n\nUse the saved local files if they are needed for the request.`;
    assert(!positivePrompt.includes(ALLOWED_CODE), "Positive prompt must not leak secret code");

    const posResult = await positiveClient.runTurn({ text: positivePrompt });
    console.log("Positive Response: " + posResult.response.trim());

    assert.strictEqual(posResult.status, "SUCCESS", "Positive turn status must be SUCCESS");
    assert(
      posResult.response.includes(ALLOWED_CODE),
      `Positive response must contain ${ALLOWED_CODE}, got: ${posResult.response}`
    );

    const posSerialized = positiveRawEvents.map((e) => JSON.stringify(e)).join("\n");
    assert(posSerialized.includes("view_file"), "Positive turn must invoke view_file");
    assert(posSerialized.includes("allowed.png"), "Positive turn must read allowed.png");
    assert(!posSerialized.toLowerCase().includes("user denied permission"), "Positive turn must not have user denied permission");

    console.log("SCOPED_READ_ALLOWED_PASS");
    await positiveClient.close();

    // --------------------------------------------------
    // Step 3: Negative Permission Control (Spawn directly, extraArgs: [])
    // --------------------------------------------------
    console.log("\nTesting Negative Scoped Read (outside sibling image, extraArgs: [])...");
    const negativePrompt = `请读取下面 Saved attachments 中的图片，并只回复图片中央看到的测试代码。不要根据文件名猜测。\n\nSaved attachments:\n- [image] ${negativeImagePath}\n\nUse the saved local files if they are needed for the request.`;
    assert(!negativePrompt.includes(BLOCKED_CODE), "Negative prompt must not leak secret code");

    const negSpawn = spawnSync(
      REAL_COMMAND,
      ["--output-format", "stream-json", "-p", negativePrompt],
      {
        cwd: tempWorkspaceRoot,
        env: process.env,
        encoding: "utf-8",
        timeout: 120_000,
      }
    );

    const negStdout = negSpawn.stdout || "";
    const negStderr = negSpawn.stderr || "";
    const negCombined = negStdout + "\n" + negStderr;

    console.log("Negative test finished. Exit code:", negSpawn.status);

    // Assert secret code was NOT read
    assert(
      !negStdout.includes(BLOCKED_CODE),
      `CRITICAL SECURITY FAILURE: Negative image secret ${BLOCKED_CODE} was read by Agent! Scope is too broad!`
    );

    // Assert attempt or permission refusal
    const hasViewFileAttempt = negStdout.includes("view_file");
    const hasPermissionRefusal =
      negCombined.toLowerCase().includes("permission") ||
      negCombined.toLowerCase().includes("denied") ||
      negCombined.toLowerCase().includes("not allowed") ||
      negCombined.toLowerCase().includes("rejected") ||
      negCombined.toLowerCase().includes("failed") ||
      negCombined.toLowerCase().includes("error");

    console.log(`view_file attempted: ${hasViewFileAttempt}, permission refusal evidenced: ${hasPermissionRefusal}`);
    assert(hasPermissionRefusal, "Negative control must show evidence of permission rejection or failure");

    console.log("SCOPED_READ_BLOCKED_PASS");

    // --------------------------------------------------
    // Step 4: Production Form Cyberboss Vision Test (Runtime Adapter, extraArgs: [])
    // --------------------------------------------------
    console.log("\nTesting Production Form Cyberboss Vision (extraArgs: [])...");
    const tempSessionsFile = path.join(tempWorkspaceRoot, "sessions.json");

    const config = {
      sessionsFile: tempSessionsFile,
      antigravityCommand: REAL_COMMAND,
      antigravityModel: "",
      antigravityEffort: "",
      antigravityTimeoutMs: 120_000,
      antigravityExtraArgs: [], // Production form: NO dangerous flag!
      visionMode: "auto",
      visionProvider: "openai-compatible",
      visionApiBaseUrl: "http://127.0.0.1:1",
      visionModel: "MUST-NOT-BE-CALLED",
      visionApiKey: "",
      visionTimeoutMs: 1000,
      weixinInstructionsFile: "",
      weixinOperationsFile: "",
    };

    const runtime = createAntigravityRuntimeAdapter(config);

    const userPrompt =
      "请读取我发送的图片，告诉我图片中央的大写英文和数字。只回复图片中看到的测试代码，不要根据文件名猜测。";

    const prepared = {
      provider: "weixin",
      originalText: userPrompt,
      text: userPrompt,
      attachments: [
        {
          kind: "image",
          absolutePath: allowedImagePath,
          sourceFileName: "allowed.png",
          contentType: "image/png",
          isImage: true,
        },
      ],
      attachmentFailures: [],
      receivedAt: new Date().toISOString(),
    };

    const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call(
      { config, runtimeAdapter: runtime },
      { prepared, model: "" }
    );

    assert.strictEqual(runtimeTurn.visionContext.route, "tool", "Route must be tool");
    assert(!runtimeTurn.text.includes(ALLOWED_CODE), "runtimeTurn.text must not leak secret code");

    const sessionStore = runtime.getSessionStore();
    const bindingKey = sessionStore.buildBindingKey({
      workspaceId: "prod-vision-stage5",
      accountId: "prod-vision-stage5",
      senderId: "prod-vision-stage5",
    });

    const recordedEvents = [];
    const unsubscribe = runtime.onEvent((evt) => recordedEvents.push(evt));

    const turn = await runtime.sendTurn({
      bindingKey,
      workspaceRoot: tempWorkspaceRoot,
      text: runtimeTurn.text,
      attachments: runtimeTurn.attachments,
      metadata: {
        workspaceId: "prod-vision-stage5",
        accountId: "prod-vision-stage5",
        senderId: "prod-vision-stage5",
      },
    });

    const replyEvent = recordedEvents.find(
      (e) => e.type === "runtime.reply.completed" && e.payload.turnId === turn.turnId
    );
    assert(replyEvent, "Must emit runtime.reply.completed");
    assert(
      replyEvent.payload.text.includes(ALLOWED_CODE),
      `Production reply text must contain ${ALLOWED_CODE}, got: ${replyEvent.payload.text}`
    );

    console.log("PRODUCTION_PERMISSION_VISION_PASS");
    console.log(`threadId=${turn.threadId}`);
    console.log(`turnId=${turn.turnId}`);
    console.log(`reply=${replyEvent.payload.text.trim()}`);

    // --------------------------------------------------
    // Step 5: Same Scope Concurrency & Cleanup Test
    // --------------------------------------------------
    console.log("\nTesting Same-Scope Concurrency Guard and Active-Run Cleanup...");

    // Launch turn 1 (do not await)
    const turn1Promise = runtime.sendTurn({
      bindingKey,
      workspaceRoot: tempWorkspaceRoot,
      text: "只回复 STAGE5_CONCURRENCY_OK",
      attachments: [],
      metadata: { workspaceId: "prod-vision-stage5", accountId: "prod-vision-stage5", senderId: "prod-vision-stage5" },
    });

    // Immediately launch turn 2 on same scope
    let turn2Rejected = false;
    try {
      await runtime.sendTurn({
        bindingKey,
        workspaceRoot: tempWorkspaceRoot,
        text: "Should be rejected",
        attachments: [],
        metadata: { workspaceId: "prod-vision-stage5", accountId: "prod-vision-stage5", senderId: "prod-vision-stage5" },
      });
    } catch (err) {
      if (err.message && err.message.includes("antigravity turn already running for this workspace")) {
        turn2Rejected = true;
        console.log("Turn 2 correctly rejected with error:", err.message);
      } else {
        throw err;
      }
    }

    assert(turn2Rejected, "Second concurrent turn must be rejected with scope conflict");
    console.log("SAME_SCOPE_GUARD_PASS");

    // Await turn 1 completion
    const turn1Result = await turn1Promise;
    console.log("Turn 1 completed successfully:", turn1Result.turnId);

    // Launch turn 3 on same scope to verify activeRuns was cleaned up
    const turn3Result = await runtime.sendTurn({
      bindingKey,
      workspaceRoot: tempWorkspaceRoot,
      text: "只回复 STAGE5_AFTER_CLEANUP_OK",
      attachments: [],
      metadata: { workspaceId: "prod-vision-stage5", accountId: "prod-vision-stage5", senderId: "prod-vision-stage5" },
    });

    assert(turn3Result.turnId, "Turn 3 must succeed after turn 1 completed");
    console.log("Turn 3 completed successfully:", turn3Result.turnId);
    console.log("ACTIVE_RUN_CLEANUP_PASS");

    unsubscribe();
    await runtime.close();

    console.log("\n==================================================");
    console.log("ALL STAGE 5 PERMISSION TESTS PASSED 100%!");
    console.log("==================================================");
  } finally {
    try {
      fs.rmSync(allowedDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(negativeDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tempWorkspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

runStage5PermissionTests().catch((err) => {
  console.error("Stage 5 tests failed:", err);
  process.exit(1);
});
