const fs = require("fs");
const path = require("path");

const DEFAULT_VEGLIA_URL = "http://127.0.0.1:8513";
const DEFAULT_TIMEOUT_MS = 5000;

const DEFAULT_APP_LABELS = {
  "com.android.settings": "系统设置",
  "com.tencent.mm": "微信",
  "tv.danmaku.bili": "哔哩哔哩",
  "com.xingin.xhs": "小红书",
  "dev.veglia.companion": "Veglia",
  "com.google.android.youtube": "YouTube",
  "com.eg.android.AlipayGphone": "支付宝",
  "com.taobao.taobao": "淘宝",
  "com.jingdong.app.mall": "京东",
  "com.ss.android.ugc.aweme": "抖音",
  "com.coolapk.market": "酷安",
  "com.tencent.mobileqq": "QQ",
  "com.netease.cloudmusic": "网易云音乐",
  "mark.via": "Via浏览器",
  "com.android.chrome": "Chrome",
  "com.coloros.launcher": "手机桌面",
  "com.android.launcher": "手机桌面",
};

class VegliaActivitySource {
  constructor(options = {}) {
    this.baseUrl = normalizeUrl(options.baseUrl || options.vegliaUrl || process.env.CYBERBOSS_VEGLIA_URL || DEFAULT_VEGLIA_URL);
    this.token = resolveVegliaToken(options);
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn || (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
    this.customAppLabels = { ...DEFAULT_APP_LABELS, ...(options.appLabels || {}) };
  }

  getAppLabel(app) {
    if (!app || typeof app !== "string") {
      return "unknown";
    }
    return this.customAppLabels[app] || app;
  }

  async getActivity() {
    if (typeof this.fetchFn !== "function") {
      return {
        ok: false,
        error: "fetch is not available in current environment",
        events: [],
        mostRecent: null,
      };
    }

    const endpoint = `${this.baseUrl}/phone/activity`;
    const headers = {};
    if (this.token) {
      headers["X-Auth-Token"] = this.token;
    }

    try {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;

      const response = await this.fetchFn(endpoint, {
        method: "GET",
        headers,
        signal: controller ? controller.signal : undefined,
      });

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        return {
          ok: false,
          error: `HTTP ${response.status} ${response.statusText || ""}`.trim(),
          events: [],
          mostRecent: null,
        };
      }

      const data = await response.json();
      if (!data || data.ok === false) {
        return {
          ok: false,
          error: data?.error || "Veglia returned non-ok response",
          events: [],
          mostRecent: null,
        };
      }

      const rawEvents = Array.isArray(data.events) ? data.events : [];
      const formattedEvents = rawEvents.map((ev) => {
        const pkg = String(ev?.app || "").trim();
        const ts = Number.parseInt(String(ev?.ts || ""), 10) || 0;
        return {
          app: pkg,
          label: this.getAppLabel(pkg),
          ts,
          event: String(ev?.event || "switch"),
        };
      });

      const mostRecent = formattedEvents.length > 0 ? formattedEvents[formattedEvents.length - 1] : null;

      let current = null;
      if (data.current && typeof data.current === "object") {
        const curApp = String(data.current.app || "").trim();
        const curTs = Number.parseInt(String(data.current.lastHeartbeatTs || ""), 10) || 0;
        current = {
          app: curApp,
          label: this.getAppLabel(curApp),
          screenInteractive: Boolean(data.current.screenInteractive),
          lastHeartbeatTs: curTs,
        };
      }

      return {
        ok: true,
        current,
        events: formattedEvents,
        mostRecent,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error || "unknown error"),
        current: null,
        events: [],
        mostRecent: null,
      };
    }
  }
}

function normalizeUrl(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.replace(/\/+$/, "");
}

function resolveVegliaToken(options = {}) {
  const explicit = options.token || options.vegliaToken || process.env.CYBERBOSS_VEGLIA_TOKEN || process.env.VEGLIA_TOKEN;
  if (explicit && typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }

  const envFile = options.envFile || options.vegliaEnvFile || process.env.CYBERBOSS_VEGLIA_ENV_FILE;
  if (envFile && typeof envFile === "string" && envFile.trim()) {
    try {
      const resolved = path.resolve(envFile.trim());
      if (fs.existsSync(resolved)) {
        const content = fs.readFileSync(resolved, "utf8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("VEGLIA_TOKEN=") && !trimmed.startsWith("#")) {
            const val = trimmed.slice("VEGLIA_TOKEN=".length).trim().replace(/^['"]|['"]$/g, "");
            if (val) {
              return val;
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return "";
}

module.exports = {
  VegliaActivitySource,
  DEFAULT_APP_LABELS,
  DEFAULT_VEGLIA_URL,
  resolveVegliaToken,
};
