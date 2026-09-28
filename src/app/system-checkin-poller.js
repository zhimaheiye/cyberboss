const crypto = require("crypto");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { CheckinConfigStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");
const { fetchVegliaContext, classifyPresence, detectInteractiveEntertainment } = require("./veglia-context");

const INTERNAL_CHECKIN_TRIGGER_TEMPLATE = "%USER% comes to mind again.";

async function runSystemCheckinPoller(config) {
  const account = resolveSelectedAccount(config);
  const queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
  const sessionStore = new SessionStore({ filePath: config.sessionsFile });
  const target = resolvePollerTarget({ config, account, sessionStore });
  const defaultRange = resolveDefaultCheckinRange();
  let currentRange = checkinConfigStore.getRange(defaultRange);

  console.log(`[cyberboss] checkin poller ready user=${target.senderId} workspace=${target.workspaceRoot}`);
  console.log(`[cyberboss] checkin interval range ${formatRangeMinutes(currentRange)}`);

  while (true) {
    currentRange = checkinConfigStore.getRange(defaultRange);
    const delayMs = pickRandomDelayMs(currentRange.minIntervalMs, currentRange.maxIntervalMs);
    const wakeAt = formatLocalTime(Date.now() + delayMs);
    console.log(`[cyberboss] next checkin in ${Math.round(delayMs / 60000)}m at ${wakeAt}`);
    await sleep(delayMs);

    if (isQuietHoursShanghai()) {
      console.log("[cyberboss] checkin skipped: quiet hours 03:00-09:00 Asia/Shanghai");
      continue;
    }

    if (queue.hasPendingForAccount(account.accountId)) {
      console.log("[cyberboss] checkin skipped: pending system message still in queue");
      continue;
    }

    let presence;
    try {
      const ctx = await fetchVegliaContext();
      presence = classifyPresence(ctx);
      console.log(`[cyberboss] veglia presence=${presence.kind} summary=${presence.summary}`);
    } catch (error) {
      console.log(`[cyberboss] checkin skipped: veglia fetch failed (${error?.message || error})`);
      continue;
    }

    if (presence.kind === "away_or_asleep" || presence.kind === "unknown") {
      console.log(`[cyberboss] checkin skipped: ${presence.kind} — no model wake / no prefab spam`);
      continue;
    }

    const queued = queue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: buildCheckinTrigger(config, presence),
      createdAt: new Date().toISOString(),
    });
    console.log(`[cyberboss] checkin queued id=${queued.id}`);
  }
}

function resolvePollerTarget({ config, account, sessionStore }) {
  const senderId = resolvePreferredSenderId({
    config,
    accountId: account.accountId,
    explicitUser: process.env.CYBERBOSS_CHECKIN_USER_ID || "",
    sessionStore,
  });
  const workspaceRoot = resolvePreferredWorkspaceRoot({
    config,
    accountId: account.accountId,
    senderId,
    explicitWorkspace: process.env.CYBERBOSS_CHECKIN_WORKSPACE || "",
    sessionStore,
  });

  if (!senderId) {
    throw new Error("Cannot determine the WeChat user for the checkin poller. Set CYBERBOSS_CHECKIN_USER_ID or let the only active user talk to the bot once first.");
  }
  if (!workspaceRoot) {
    throw new Error("Cannot determine the workspace for the checkin poller. Set CYBERBOSS_WORKSPACE_ROOT first.");
  }

  return { senderId, workspaceRoot };
}

function pickRandomDelayMs(minIntervalMs, maxIntervalMs) {
  if (maxIntervalMs <= minIntervalMs) {
    return minIntervalMs;
  }
  return minIntervalMs + Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLocalTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "");
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function formatRangeMinutes(range) {
  return `${Math.round(range.minIntervalMs / 60000)}m-${Math.round(range.maxIntervalMs / 60000)}m`;
}

function buildCheckinTrigger(config, presence) {
  const userName = normalizeText(config?.userName) || "the user";
  const base = INTERNAL_CHECKIN_TRIGGER_TEMPLATE.replace("%USER%", userName);
  const snapshotJson = JSON.stringify(presence.snapshot || { summary: presence.summary }, null, 0);
  const entertainment = detectInteractiveEntertainment(presence);
  const lines = [
    base,
    "LIVE_VEGLIA_SNAPSHOT (authoritative; do not invent other device state):",
    snapshotJson,
    "SUMMARY:",
    presence.summary,
    "RULES: Judge only from this snapshot + recent WeChat.",
  ];

  if (entertainment.prefer_send) {
    const hitText = entertainment.hits
      .map((hit) => `${hit.device_id}:${hit.app}${hit.idle_seconds === null || hit.idle_seconds === undefined ? "" : ` idle=${Math.round(hit.idle_seconds)}s`}`)
      .join("; ");
    lines.push(
      `ENTERTAINMENT_SIGNAL: interactive play/scroll detected (${hitText}).`,
      "PREFER_SEND: clear interactive entertainment/scroll is live (B站/哔哩哔哩、MuMu 模拟器 idle<120、小红书/短视频、游戏等). Prefer ONE short Chinese send_message nudge.",
      "Do NOT default to silent. Do NOT hide behind a prior daytime light-touch cooldown. Do NOT apply happyfish/Maa hang-script exemption here — that exemption is ONLY when PC study/work is primary AND phone/emulator is hung idle, NOT when primary focus is Bilibili/MuMu interactive/games.",
      "Still forbid study-spam with no evidence. Quiet hours / away_or_asleep already gated upstream.",
    );
  } else {
    lines.push(
      "Default action silent when awake but studying/working/ambiguous.",
      "If phone/PC is primary/interactive on entertainment or scroll (e.g. B站/哔哩哔哩, MuMu idle<120, 小红书/xhs, short-video, games) for ~20m+ continuous OR clear play focus with low idle, and play-cooldown (~25m) has passed, prefer one short Chinese nudge — do not hide behind default silent or a prior daytime light-touch.",
      "Happyfish/Maa hang-script exemption ONLY when PC study/work is primary and phone/emulator is hung idle — NOT when primary focus is Bilibili/MuMu interactive/games.",
      "Send at most one short Chinese line only if snapshot clearly shows mindless play/scroll needing a nudge, or a due reminder, or you truly lost track while she is awake.",
      "Never send prefabricated study spam. Never claim she is studying/sleeping unless snapshot supports it.",
    );
  }

  return lines.join("\n");
}

function isQuietHoursShanghai(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "numeric",
    hour12: false,
  }).format(now));
  return hour >= 3 && hour < 9;
}

module.exports = { runSystemCheckinPoller };
