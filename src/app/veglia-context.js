const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const DEFAULT_VEGLIA_MCP_URL = "https://mcp.zhimaheiye.dpdns.org/mcp";
const SAMPLE_PATH = "/tmp/veglia-life-sample.json";

async function fetchVegliaContext({ mcpUrl = process.env.VEGLIA_MCP_URL || DEFAULT_VEGLIA_MCP_URL, timeoutMs = 20000 } = {}) {
  const session = await mcpInitialize(mcpUrl, timeoutMs);
  try {
    await mcpNotify(mcpUrl, session, { jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs);
  } catch {
    // some servers ignore this notification
  }
  const raw = await mcpCall(mcpUrl, session, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_context", arguments: {} },
  }, timeoutMs);
  const payload = extractToolPayload(raw);
  if (payload && typeof payload === "object") {
    try {
      fs.writeFileSync(SAMPLE_PATH, JSON.stringify(payload, null, 2));
    } catch {
      // best-effort cache for other companion tools
    }
  }
  return payload;
}

function classifyPresence(ctx) {
  if (!ctx || ctx.ok === false || !Array.isArray(ctx.devices)) {
    return { kind: "unknown", summary: "veglia unavailable" };
  }
  const phone = ctx.devices.find((d) => d.device_id === "phone" || d.device_type === "android_phone");
  const pcs = ctx.devices.filter((d) => d.device_type === "windows_pc" || String(d.device_id || "").includes("pc"));
  const phoneAwake = Boolean(
    phone
    && phone.online
    && phone.screen_interactive !== false
    && phone.activity_state !== "offline"
  );
  const activePc = pcs.some((d) => d.online && typeof d.idle_seconds === "number" && d.idle_seconds < 180);
  const summary = summarizeContext(ctx);
  if (!phoneAwake && !activePc) {
    return { kind: "away_or_asleep", summary };
  }
  return { kind: "present", summary, snapshot: compactSnapshot(ctx) };
}

function summarizeContext(ctx) {
  const parts = [];
  for (const d of ctx.devices || []) {
    const id = d.device_id || "?";
    if (id === "phone" || d.device_type === "android_phone") {
      if (!d.online || d.screen_interactive === false) {
        parts.push("phone:off/screen-off");
      } else {
        const app = d.foreground?.label || d.foreground?.app || "?";
        parts.push(`phone:on ${app}`);
      }
      continue;
    }
    if (!d.online) {
      parts.push(`${id}:offline`);
      continue;
    }
    const app = d.foreground?.label || d.foreground?.app || "?";
    const title = d.foreground?.title || "";
    const idle = typeof d.idle_seconds === "number" ? ` idle=${Math.round(d.idle_seconds)}s` : "";
    parts.push(`${id}:${app}${title ? `「${String(title).slice(0, 40)}」` : ""}${idle}`);
  }
  return parts.join(" | ");
}

function compactSnapshot(ctx) {
  return {
    generated_at: ctx.generated_at,
    active_devices: ctx.active_devices,
    simultaneous_usage: ctx.simultaneous_usage,
    ambiguous: ctx.ambiguous,
    reasons: ctx.reasons,
    devices: (ctx.devices || []).map((d) => ({
      device_id: d.device_id,
      online: d.online,
      activity_state: d.activity_state,
      screen_interactive: d.screen_interactive,
      idle_seconds: d.idle_seconds,
      foreground: d.foreground,
    })),
  };
}

function extractToolPayload(sseOrJson) {
  const text = String(sseOrJson || "");
  let message = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data: ")) {
      try {
        message = JSON.parse(line.slice(6));
      } catch {
        // continue
      }
    }
  }
  if (!message) {
    try {
      message = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const result = message.result || message;
  const content = result.content;
  if (Array.isArray(content)) {
    const block = content.find((c) => c && typeof c.text === "string");
    if (block) {
      try {
        return JSON.parse(block.text);
      } catch {
        return { raw_text: block.text };
      }
    }
  }
  if (result && typeof result === "object" && result.ok !== undefined) {
    return result;
  }
  return null;
}

async function mcpInitialize(mcpUrl, timeoutMs) {
  const { body, headers } = await httpJson(mcpUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cyberboss-checkin", version: "1" },
    },
  }, null, timeoutMs);
  const session = headers["mcp-session-id"] || headers["Mcp-Session-Id"];
  if (!session) {
    throw new Error("veglia mcp missing session id");
  }
  // drain body
  void body;
  return session;
}

async function mcpNotify(mcpUrl, session, payload, timeoutMs) {
  await httpJson(mcpUrl, payload, session, timeoutMs);
}

async function mcpCall(mcpUrl, session, payload, timeoutMs) {
  const { body } = await httpJson(mcpUrl, payload, session, timeoutMs);
  return body;
}

function httpJson(mcpUrl, payload, session, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(mcpUrl);
    const lib = target.protocol === "http:" ? http : https;
    const data = Buffer.from(JSON.stringify(payload));
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "cyberboss-checkin/1",
      "Content-Length": data.length,
    };
    if (session) {
      headers["mcp-session-id"] = session;
    }
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "http:" ? 80 : 443),
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`veglia http ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        resolve({ body, headers: res.headers, statusCode: res.statusCode });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("veglia request timeout"));
    });
    req.write(data);
    req.end();
  });
}


const ENTERTAINMENT_APP_RE = /哔哩哔哩|bilibili|\bb\s*站\b|B站|小红书|\bxhs\b|抖音|快手|tiktok|youtube|游戏中心|gamecenter|游戏|mu\s*mu|模拟器|mumu|happyelements|happyfish|开心水族|steam|epic|网易云游戏|taptap|hykb|王者荣耀|原神|崩坏|绝区零|鸣潮|和平精英|蛋仔|代号鸢|如鸢|阴阳师|明日方舟/i;
const SHORT_VIDEO_OR_SCROLL_RE = /小红书|\bxhs\b|抖音|快手|tiktok|reels|shorts/i;
const HANG_SCRIPT_APP_RE = /开心水族|happyfish|happyelements|maa|明日方舟|挂机|挂脚本/i;
const STUDY_WORK_RE = /数据结构|学习|作业|论文|obsidian|vscode|code\.exe|idea64|word|excel|powerpoint|deeptutor|notion|typora|考研|刷题|leetcode/i;

function detectInteractiveEntertainment(ctxOrPresence = null) {
  const snapshot = resolveEntertainmentSource(ctxOrPresence);
  const devices = Array.isArray(snapshot?.devices) ? snapshot.devices : [];
  const hits = [];

  for (const device of devices) {
    if (!device || device.online === false) {
      continue;
    }
    const label = String(device.foreground?.label || device.foreground?.app || "");
    const title = String(device.foreground?.title || "");
    const blob = `${label} ${title} ${device.device_id || ""}`;
    const idle = typeof device.idle_seconds === "number" ? device.idle_seconds : null;
    const isPhone = device.device_id === "phone" || device.device_type === "android_phone";
    const interactive = isPhone
      ? device.screen_interactive !== false && device.activity_state !== "offline"
      : idle !== null && idle < 120;

    if (!interactive) {
      continue;
    }
    if (!ENTERTAINMENT_APP_RE.test(blob)) {
      continue;
    }

    // Hang-only Maa/happyfish: high idle, explicit hang wording, or PC study/work primary
    // with a classic hang-script app → NOT interactive entertainment.
    const hangApp = HANG_SCRIPT_APP_RE.test(blob);
    const hangLikely = hangApp && (
      (idle !== null && idle >= 120)
      || /挂机|挂脚本|脚本/.test(blob)
      || devicesSomeStudyWork(devices)
    );
    if (hangLikely) {
      continue;
    }

    hits.push({
      device_id: device.device_id || "",
      app: label || title || "?",
      title: title.slice(0, 80),
      idle_seconds: idle,
      scroll_like: SHORT_VIDEO_OR_SCROLL_RE.test(blob),
    });
  }

  if (!hits.length) {
    return {
      interactive: false,
      prefer_send: false,
      reason: "no_interactive_entertainment",
      hits: [],
      study_or_work_primary: devicesSomeStudyWork(devices),
    };
  }

  const studyOrWork = devicesSomeStudyWork(devices);
  // Prefer send when clear interactive entertainment is the focus.
  // Hang exemption only when PC study/work is primary AND entertainment device is hang-idle — already filtered.
  return {
    interactive: true,
    prefer_send: true,
    reason: studyOrWork
      ? "interactive_entertainment_alongside_study_still_nudge_eligible"
      : "clear_interactive_entertainment",
    hits,
    study_or_work_primary: studyOrWork,
  };
}

function devicesSomeStudyWork(devices) {
  return (devices || []).some((device) => {
    if (!device || device.online === false) {
      return false;
    }
    const idle = typeof device.idle_seconds === "number" ? device.idle_seconds : null;
    const isPhone = device.device_id === "phone" || device.device_type === "android_phone";
    if (isPhone) {
      return false;
    }
    if (idle !== null && idle >= 180) {
      return false;
    }
    const blob = `${device.foreground?.label || ""} ${device.foreground?.title || ""} ${device.foreground?.app || ""}`;
    return STUDY_WORK_RE.test(blob);
  });
}

function resolveEntertainmentSource(ctxOrPresence) {
  if (!ctxOrPresence || typeof ctxOrPresence !== "object") {
    return null;
  }
  if (Array.isArray(ctxOrPresence.devices)) {
    return ctxOrPresence;
  }
  if (ctxOrPresence.snapshot && Array.isArray(ctxOrPresence.snapshot.devices)) {
    return ctxOrPresence.snapshot;
  }
  if (typeof ctxOrPresence.summary === "string") {
    return synthesizeSnapshotFromSummary(ctxOrPresence.summary);
  }
  return null;
}

function synthesizeSnapshotFromSummary(summary) {
  const devices = [];
  for (const part of String(summary || "").split("|")) {
    const chunk = part.trim();
    if (!chunk) continue;
    const idleMatch = chunk.match(/idle=(\d+(?:\.\d+)?)s/i);
    const idle = idleMatch ? Number(idleMatch[1]) : null;
    if (/^phone:/i.test(chunk)) {
      const off = /off|screen-off/i.test(chunk);
      devices.push({
        device_id: "phone",
        device_type: "android_phone",
        online: !off,
        screen_interactive: !off,
        activity_state: off ? "offline" : "active",
        idle_seconds: idle,
        foreground: { label: chunk.replace(/^phone:\s*/i, "").replace(/^on\s+/i, "") },
      });
      continue;
    }
    const idMatch = chunk.match(/^([^:]+):/);
    const id = idMatch ? idMatch[1] : "pc";
    const rest = chunk.slice((idMatch ? idMatch[0].length : 0));
    const titleMatch = rest.match(/「([^」]*)」/);
    devices.push({
      device_id: id,
      device_type: "windows_pc",
      online: !/offline/i.test(chunk),
      idle_seconds: idle,
      foreground: {
        label: rest.replace(/「[^」]*」/g, "").replace(/\s*idle=\d+(?:\.\d+)?s/i, "").trim(),
        title: titleMatch ? titleMatch[1] : "",
      },
    });
  }
  return { devices };
}


module.exports = {
  fetchVegliaContext,
  classifyPresence,
  summarizeContext,
  detectInteractiveEntertainment,
};
