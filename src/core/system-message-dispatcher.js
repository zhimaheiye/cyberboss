const { detectInteractiveEntertainment } = require("../app/veglia-context");

class SystemMessageDispatcher {
  constructor({ queueStore, config, accountId }) {
    this.queueStore = queueStore;
    this.config = config;
    this.accountId = accountId;
  }

  hasPending() {
    return this.queueStore.hasPendingForAccount(this.accountId);
  }

  drainPending() {
    return this.queueStore.drainForAccount(this.accountId);
  }

  requeue(message) {
    return this.queueStore.enqueue(message);
  }

  resolveWorkspaceRoot(message) {
    return normalizeText(message?.workspaceRoot) || normalizeText(this.config.workspaceRoot);
  }

  buildPreparedMessage(message, contextToken = "") {
    return {
      provider: "system",
      workspaceId: this.config.workspaceId,
      accountId: this.accountId,
      chatId: message.senderId,
      threadKey: `system:${message.senderId}`,
      senderId: message.senderId,
      messageId: message.id,
      text: buildSystemInboundText(message?.text, message?.createdAt),
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
    };
  }
}

function buildSystemInboundText(text, createdAt = "") {
  const body = normalizeText(text);
  const localTime = formatSystemLocalTime(createdAt);
  const entertainment = detectEntertainmentFromTrigger(body);
  const sections = [
    ...(localTime ? [`[${localTime}]`, ""] : []),
    "SYSTEM ACTION MODE: internal trigger, not user chat.",
    "Before ANY send_message: call Veglia (get_devices_activity / get_context) and read phone_scroll_state.json + desktop_play_state.json + recent chat.",
    "Hard silent if: Asia/Shanghai quiet hours 03:00-09:00; OR phone offline/screen-off and PCs idle/offline (likely sleeping).",
  ];

  if (entertainment.prefer_send) {
    sections.push(
      "PREFER_SEND (LIVE entertainment): snapshot/trigger shows clear interactive entertainment/scroll (B站/哔哩哔哩、MuMu idle<120、小红书/短视频、游戏等).",
      "Prefer ONE short Chinese send_message. Do NOT default to silent. Do NOT hide behind prior daytime light-touch (~45m). Play/scroll interrupt is a SEPARATE ~25m budget.",
      "Happyfish/Maa hang-script exemption does NOT apply when primary focus is Bilibili/MuMu interactive/games — only when PC study/work is primary and phone/emulator is hung idle.",
      `Entertainment hits: ${entertainment.hits.map((h) => `${h.device_id}:${h.app}`).join("; ") || entertainment.reason}`,
    );
  } else {
    sections.push(
      "Default action is silent. Do NOT message just because you woke up.",
      "Cooldown: same-style daytime light-touch ~45m. Play/scroll interrupt is a SEPARATE budget (~25m) — if LIVE snapshot shows interactive entertainment/scroll (B站/哔哩哔哩, MuMu idle<120, 小红书/xhs, short-video, games) for ~20m+ OR clear play focus with low idle, do NOT stay silent only because a light-touch fired earlier.",
      "Happyfish/Maa hang-script exemption applies ONLY when she is studying/working on a PC and phone/emulator is hung idle — NOT when primary focus is Bilibili/MuMu interactive/games.",
    );
  }

  sections.push(
    "Never send empty study spam like repeating 数据结构/继续学习/保持专注 with no device evidence she is awake and studying/need a nudge.",
    "Only send_message for: real mindless scroll/play needing a nudge with no valid hang exemption; a due reminder; one short contextual check-in when awake and you genuinely lost track of her.",
    "One short Chinese WeChat line if sending. Never a timeline dump / bullet report.",
    "Do timeline/diary privately if useful, then still prefer silent unless messaging is justified above.",
    "Return exactly one JSON object after any tool calls:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
    "No markdown fences. No reasoning. No text outside the JSON. Trailing junk after the JSON is ignored by the bridge, but still prefer clean JSON only.",
  );
  if (body) {
    sections.push("", "Trigger:", body);
  }
  return sections.join("\n").trim();
}

function detectEntertainmentFromTrigger(triggerText) {
  const text = String(triggerText || "");
  // Prefer structured LIVE snapshot JSON inside the trigger when present.
  const snapshotMatch = text.match(/LIVE_VEGLIA_SNAPSHOT[\s\S]*?(\nSUMMARY:|$)/);
  let snapshot = null;
  if (snapshotMatch) {
    const jsonMatch = text.match(/LIVE_VEGLIA_SNAPSHOT[^\n]*\n([\s\S]*?)\nSUMMARY:/);
    if (jsonMatch) {
      try {
        snapshot = JSON.parse(jsonMatch[1].trim());
      } catch {
        snapshot = null;
      }
    }
  }
  if (snapshot) {
    return detectInteractiveEntertainment(snapshot);
  }
  if (/ENTERTAINMENT_SIGNAL:|PREFER_SEND:/i.test(text)) {
    return { prefer_send: true, interactive: true, reason: "trigger_marked_prefer_send", hits: [] };
  }
  // Fall back to summary / keyword scan of the whole trigger.
  return detectInteractiveEntertainment({ summary: text });
}

function formatSystemLocalTime(value) {
  const normalized = normalizeIsoTime(value);
  if (!normalized) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(normalized)).replace(/\//g, "-");
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SystemMessageDispatcher };
