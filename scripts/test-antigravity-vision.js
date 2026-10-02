const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { CyberbossApp } = require("../src/core/app");
const { createAntigravityRuntimeAdapter } = require("../src/adapters/runtime/antigravity");
const { AntigravityProcessClient } = require("../src/adapters/runtime/antigravity/process-client");

const REAL_COMMAND = process.env.CYBERBOSS_ANTIGRAVITY_COMMAND || "antigravity";
const EXPECTED_CODE = "AGY_VISUAL_7319";

function createTestImage(targetPath) {
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

  const tmpPs1 = path.join(path.dirname(targetPath), "create-image.ps1");
  fs.writeFileSync(tmpPs1, ps1Script, "utf-8");

  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmpPs1, EXPECTED_CODE, targetPath],
    { encoding: "utf-8" }
  );

  try {
    fs.unlinkSync(tmpPs1);
  } catch {
    // ignore
  }

  if (res.status !== 0 || !fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
    throw new Error(`PowerShell image generation failed (exit: ${res.status}): ${res.stderr || res.stdout}`);
  }

  console.log("TEST_IMAGE_CREATED");
  console.log(`path=${targetPath}`);
  console.log(`size=${fs.statSync(targetPath).size}`);
}

async function runStage4VisionTests() {
  console.log("==================================================");
  console.log("Running Stage 4: Antigravity Vision Integration");
  console.log("==================================================");

  const tempRoot = path.join(os.tmpdir(), `cyberboss-antigravity-vision-${Date.now()}`);
  const tempWorkspaceRoot = path.join(tempRoot, "workspace");
  const tempInbox = path.join(tempRoot, "inbox");
  const tempState = path.join(tempRoot, "state");
  const tempSessionsFile = path.join(tempState, "sessions.json");

  fs.mkdirSync(tempWorkspaceRoot, { recursive: true });
  fs.mkdirSync(tempInbox, { recursive: true });
  fs.mkdirSync(tempState, { recursive: true });

  const imagePath = path.join(tempInbox, "sample-image.png");

  try {
    // --------------------------------------------------
    // Step 1: Generate Test Image
    // --------------------------------------------------
    createTestImage(imagePath);
    assert(!path.basename(imagePath).includes(EXPECTED_CODE), "Image filename must not contain test code");

    // --------------------------------------------------
    // Step 2: Configure Test Runtime Adapter
    // --------------------------------------------------
    const config = {
      sessionsFile: tempSessionsFile,
      antigravityCommand: REAL_COMMAND,
      antigravityModel: "",
      antigravityEffort: "",
      antigravityTimeoutMs: 120_000,
      antigravityExtraArgs: ["--dangerously-skip-permissions"],
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

    // --------------------------------------------------
    // Step 3: Mock Inbound Prepared Message & buildRuntimeTurn
    // --------------------------------------------------
    const userPrompt =
      "请读取我发送的图片，告诉我图片中央的大写英文和数字。只回复图片中看到的测试代码，不要根据文件名猜测。";

    const prepared = {
      provider: "weixin",
      originalText: userPrompt,
      text: userPrompt,
      attachments: [
        {
          kind: "image",
          absolutePath: imagePath,
          sourceFileName: "sample-image.png",
          contentType: "image/png",
          isImage: true,
        },
      ],
      attachmentFailures: [],
      receivedAt: new Date().toISOString(),
    };

    const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call(
      {
        config,
        runtimeAdapter: runtime,
      },
      {
        prepared,
        model: "",
      }
    );

    // --------------------------------------------------
    // Step 4: Vision Routing Assertions
    // --------------------------------------------------
    console.log("\nAsserting Vision Routing...");
    assert(runtimeTurn.visionContext, "runtimeTurn.visionContext must exist");
    assert.strictEqual(runtimeTurn.visionContext.route, "tool", "Vision route must be 'tool'");
    assert.strictEqual(runtimeTurn.visionContext.items.length, 0, "Vision items must be empty");
    assert.strictEqual(runtimeTurn.visionContext.errors.length, 0, "Vision errors must be empty");
    assert.deepStrictEqual(runtimeTurn.attachments, [], "Attachments passed to model must be empty");

    assert(runtimeTurn.text.includes("Saved attachments:"), "runtimeTurn.text must include 'Saved attachments:'");
    assert(runtimeTurn.text.includes(imagePath), "runtimeTurn.text must include image absolute path");
    assert(
      runtimeTurn.text.includes("Use the saved local files if they are needed for the request."),
      "runtimeTurn.text must include saved file usage guidance"
    );
    assert(
      !runtimeTurn.text.includes("Visual context from attachments:"),
      "runtimeTurn.text must not include external caption context"
    );

    console.log("VISION_ROUTE_TOOL_PASS");

    // --------------------------------------------------
    // Step 5: Prompt Leak Guard
    // --------------------------------------------------
    assert.strictEqual(
      runtimeTurn.text.includes(EXPECTED_CODE),
      false,
      "Prompt leak guard: runtimeTurn.text must NOT leak the secret code"
    );
    console.log("PROMPT_LEAK_GUARD_PASS");

    // --------------------------------------------------
    // Step 6: Raw Antigravity ProcessClient Tool Calling Validation
    // --------------------------------------------------
    console.log("\nTesting Raw Antigravity ProcessClient Tool Calling...");
    const client = new AntigravityProcessClient({
      command: config.antigravityCommand,
      cwd: tempWorkspaceRoot,
      env: process.env,
      extraArgs: ["--dangerously-skip-permissions"],
      timeoutMs: 120_000,
    });

    const rawEvents = [];
    client.onMessage((raw) => {
      rawEvents.push(raw);
    });

    const clientResult = await client.runTurn({
      text: runtimeTurn.text,
    });

    console.log("ProcessClient Response:\n" + clientResult.response);

    assert.strictEqual(clientResult.status, "SUCCESS", "ProcessClient turn status must be SUCCESS");
    assert(
      clientResult.response.includes(EXPECTED_CODE),
      `ProcessClient response must contain ${EXPECTED_CODE}, got: ${clientResult.response}`
    );

    const serialized = rawEvents.map((e) => JSON.stringify(e)).join("\n");
    assert(serialized.includes("view_file"), "Raw events must contain view_file tool call");
    assert(serialized.includes("sample-image.png"), "Raw events must reference sample-image.png");

    console.log("AUTO_VIEW_FILE_PASS");
    await client.close();

    // --------------------------------------------------
    // Step 7: Runtime Adapter End-to-End Vision Test
    // --------------------------------------------------
    console.log("\nTesting Runtime Adapter End-to-End Vision...");
    const sessionStore = runtime.getSessionStore();
    const bindingKey = sessionStore.buildBindingKey({
      workspaceId: "vision-stage4",
      accountId: "vision-stage4",
      senderId: "vision-stage4",
    });

    const recordedEvents = [];
    const unsubscribe = runtime.onEvent((evt) => {
      recordedEvents.push(evt);
    });

    const turn = await runtime.sendTurn({
      bindingKey,
      workspaceRoot: tempWorkspaceRoot,
      text: runtimeTurn.text,
      attachments: runtimeTurn.attachments,
      metadata: {
        workspaceId: "vision-stage4",
        accountId: "vision-stage4",
        senderId: "vision-stage4",
      },
    });

    assert(turn.threadId, "turn must have a threadId");
    assert(turn.turnId, "turn must have a turnId");

    const recordedThreadId = sessionStore.getThreadIdForWorkspace(bindingKey, tempWorkspaceRoot);
    assert.strictEqual(recordedThreadId, turn.threadId, "SessionStore must record threadId");

    const turnEvents = recordedEvents.filter((e) => e.payload.turnId === turn.turnId);
    const turnEventTypes = turnEvents.map((e) => e.type);

    assert(turnEventTypes.includes("runtime.turn.started"), "Must emit runtime.turn.started");
    assert(turnEventTypes.includes("runtime.reply.completed"), "Must emit runtime.reply.completed");
    assert(turnEventTypes.includes("runtime.turn.completed"), "Must emit runtime.turn.completed");

    const replyEvent = turnEvents.find((e) => e.type === "runtime.reply.completed");
    assert(
      replyEvent.payload.text.includes(EXPECTED_CODE),
      `Runtime reply text must contain ${EXPECTED_CODE}, got: ${replyEvent.payload.text}`
    );

    console.log("RUNTIME_VISION_E2E_PASS");
    console.log(`threadId=${turn.threadId}`);
    console.log(`turnId=${turn.turnId}`);
    console.log(`reply=${replyEvent.payload.text.trim()}`);

    unsubscribe();
    await runtime.close();

    console.log("\n==================================================");
    console.log("ANTIGRAVITY_VISION_STAGE4_PASS");
    console.log("==================================================");
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

runStage4VisionTests().catch((err) => {
  console.error("Stage 4 Vision tests failed:", err);
  process.exit(1);
});
