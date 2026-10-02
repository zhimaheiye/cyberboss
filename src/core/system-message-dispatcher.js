const { detectInteractiveEntertainment } = require("../app/veglia-context");

const SYSTEM_MESSAGE_RETRY_BACKOFF_MS = {
  1: 60_000,    // retry #1: at least 1 minute
  2: 300_000,   // retry #2: at least 5 minutes
  3: 900_000,   // retry #3: at least 15 minutes
};

const MAX_SYSTEM_MESSAGE_RETRIES = 3;

class SystemMessageDispatcher {
  constructor({ queueStore, config, accountId, clock = () => Date.now() }) {
    this.queueStore = queueStore;
    this.config = config;
    this.accountId = accountId;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
  }

  hasPending() {
    return this.hasDue();
  }

  hasDue(now = this.clock()) {
    if (typeof this.queueStore?.hasDueForAccount === "function") {
      return this.queueStore.hasDueForAccount(this.accountId, now);
    }
    return this.queueStore?.hasPendingForAccount(this.accountId) || false;
  }

  drainPending(now = this.clock()) {
    if (typeof this.queueStore?.drainDueForAccount === "function") {
      return this.queueStore.drainDueForAccount(this.accountId, now);
    }
    return this.queueStore?.drainForAccount(this.accountId) || [];
  }

  requeue(message) {
    if (!message || typeof message !== "object") {
      return null;
    }

    if (message.source === "checkin" || message.source === "phone_watch") {
      console.log(`[cyberboss] ${message.source} system message failed; dropped id=${message.id}`);
      return null;
    }

    const currentAttempts = Number.isInteger(message.attempts) && message.attempts >= 0 ? message.attempts : 0;
    const newAttempts = currentAttempts + 1;

    if (newAttempts > MAX_SYSTEM_MESSAGE_RETRIES) {
      console.log(`[cyberboss] system message retries exhausted (${currentAttempts} retries); dropped id=${message.id}`);
      return null;
    }

    const backoffMs = SYSTEM_MESSAGE_RETRY_BACKOFF_MS[newAttempts] || 900_000;
    const nowMs = typeof this.clock === "function" ? this.clock() : Date.now();
    const nextAttemptAt = new Date(nowMs + backoffMs).toISOString();
    const delayMinutes = Math.round(backoffMs / 60_000);

    console.log(`[cyberboss] system message failed; scheduled retry #${newAttempts} in ${delayMinutes}m for id=${message.id}`);
    return this.queueStore.enqueue({
      ...message,
      attempts: newAttempts,
      nextAttemptAt,
    });
  }

  resolveWorkspaceRoot(message) {
    return normalizeText(message?.workspaceRoot) || normalizeText(this.config.workspaceRoot);
  }

  buildPreparedMessage(message, contextToken = "") {
    const rawSource = normalizeText(message?.source);
    const source = (rawSource === "checkin" || rawSource === "phone_watch" || rawSource === "reminder")
      ? rawSource
      : "system";
    const origin = (typeof message?.origin === "string" && message.origin.trim().toLowerCase() === "internal")
      ? "internal"
      : "user";
    const deliveryRequired = typeof message?.deliveryRequired === "boolean"
      ? message.deliveryRequired
      : (source === "reminder" && origin !== "internal");
    const fallbackText = normalizeText(message?.reminderText || message?.fallbackText || "");

    return {
      provider: "system",
      workspaceId: this.config.workspaceId,
      accountId: this.accountId,
      chatId: message.senderId,
      threadKey: `system:${message.senderId}`,
      senderId: message.senderId,
      messageId: message.id,
      text: buildSystemInboundText(message?.text, message?.createdAt, {
        source,
        origin,
        deliveryRequired,
        reminderText: message?.reminderText || "",
        dueAtMs: message?.dueAtMs,
      }),
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
      source,
      origin,
      deliveryRequired,
      fallbackText,
    };
  }
}

function buildSystemInboundText(text, createdAt = "", options = {}) {
  const body = normalizeText(text);
  const localTime = formatSystemLocalTime(createdAt);
  const entertainment = detectEntertainmentFromTrigger(body);
  const source = normalizeText(options?.source);
  const deliveryRequired = Boolean(options?.deliveryRequired);

  if (source === "reminder") {
    const sections = [
      ...(localTime ? [`[${localTime}]`, ""] : []),
      `SYSTEM ACTION MODE: internal trigger (source=reminder, deliveryRequired=${deliveryRequired}).`,
      "",
      "CRITICAL REMINDER RULES:",
      "- No background daemon, reminder poller, or other service has sent or will send this reminder text to the user.",
      "- This turn is the SOLE delivery step.",
      "- Do NOT assume the reminder was already delivered merely because it was scheduled, mentioned earlier, or because the trigger text is in system context.",
    ];

    if (deliveryRequired) {
      sections.push(
        "- FINAL ACTION REQUIREMENT: You MUST finish with send_message to deliver the reminder to the user on WeChat.",
        "- The 'silent' action is STRICTLY INVALID for this reminder. Do NOT suppress this reminder under any circumstances.",
        "- Diary, timeline, or whereabouts actions may be performed in this turn, but they CANNOT replace the user-facing WeChat message.",
        "- You may adapt wording naturally based on current context, but you must send the message.",
        "",
        "Return exactly one JSON object after any tool calls:",
        "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
        "No markdown fences. No reasoning. No text outside the JSON."
      );
    } else {
      sections.push(
        "- This is an internal/proactive reminder. You may send a message or record a diary/note or choose silent if interrupting the user is inappropriate.",
        "",
        "Return exactly one JSON object after any tool calls:",
        "{\"action\":\"silent\"}",
        "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
        "No markdown fences. No reasoning. No text outside the JSON."
      );
    }

    if (body) {
      sections.push("", "Trigger:", body);
    }
    return sections.join("\n").trim();
  }

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

module.exports = {
  SystemMessageDispatcher,
  SYSTEM_MESSAGE_RETRY_BACKOFF_MS,
  MAX_SYSTEM_MESSAGE_RETRIES,
  buildSystemInboundText,
};
