class Notifications {
  constructor(store, changed, breathing) {
    this.store = store; this.changed = changed; this.sending = false;
    this.breathing = breathing;
    this.ready = import("web-push").then(webpush => {
      this.webpush = webpush;
      store.data.vapid ||= webpush.generateVAPIDKeys(); store.save();
    });
  }
  subscribe(subscription) {
    const endpoint = new URL(subscription?.endpoint);
    // Browser push endpoints only; never turn this into an arbitrary URL fetcher.
    const host = endpoint.hostname;
    if (endpoint.protocol !== "https:" || !["fcm.googleapis.com", "updates.push.services.mozilla.com"].includes(host)
        && !host.endsWith(".notify.windows.com") && !host.endsWith(".push.apple.com")) throw new Error("不支持此浏览器推送服务");
    if (!subscription.keys?.p256dh || !subscription.keys?.auth) throw new Error("推送订阅缺少密钥");
    this.store.data.subscriptions = this.store.data.subscriptions.filter(s => s.endpoint !== subscription.endpoint);
    this.store.data.subscriptions.push(subscription); this.store.save();
    return { subscribed: true };
  }
  add(text, kind = "proactive", metadata = {}) {
    const session = this.breathing.current();
    const message = this.store.add("messages", { role: "assistant", text, kind, unread: true,
      pushStatus: session ? "deferred" : "pending", attempts: 0, ...metadata,
      ...(session ? { breathingSessionId: session.id } : {}) });
    this.changed(); return message;
  }
  isQuiet() {
    const { quietStart, quietEnd } = this.store.data.settings;
    if (!quietStart || !quietEnd || quietStart === quietEnd) return false;
    const now = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    return quietStart < quietEnd ? now >= quietStart && now < quietEnd : now >= quietStart || now < quietEnd;
  }
  async flush() {
    if (this.sending || this.breathing.current()) return;
    this.sending = true;
    try {
      await this.ready;
      for (const message of this.store.data.messages.filter(m => m.unread && m.pushStatus === "pending"
        && !(m.kind === "proactive" && this.isQuiet()) && (!m.retryAt || Date.parse(m.retryAt) <= Date.now())).slice(0, 5)) {
        if (this.breathing.current()) break;
        const job = message.jobId ? this.store.data.jobs.find(j => j.id === message.jobId) : null;
        if (job && (job.status !== "active" || Date.parse(job.suppressUntil) > Date.now() || Date.parse(job.activeUntil) < Date.now())) {
          message.pushStatus = "cancelled"; this.store.save(); continue;
        }
        if (message.kind === "proactive" && this.isQuiet()) continue;
        const subscriptions = [...this.store.data.subscriptions];
        if (!subscriptions.length) continue;
        const payload = JSON.stringify({ id: message.id, title: message.kind === "reminder" ? "CyberBoss · 到点提醒" : "CyberBoss · 有事告诉你", body: message.text.slice(0, 500), url: `/#message=${message.id}` });
        const sent = new Set(message.pushAccepted || []);
        let lastError = "";
        for (const subscription of subscriptions.filter(s => !sent.has(s.endpoint))) {
          if (this.breathing.current()) {
            message.pushAccepted = [...sent];
            this.store.save();
            return;
          }
          try {
            await this.webpush.sendNotification(subscription, payload, { timeout: 10000, TTL: 86400,
              proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined,
              vapidDetails: { subject: "https://github.com/zhimaheiye/cyberboss", ...this.store.data.vapid } });
            sent.add(subscription.endpoint);
          } catch (error) {
            lastError = `推送服务未接收 (${error.statusCode || error.code || "网络错误"})`;
            if ([404, 410].includes(error.statusCode)) this.store.data.subscriptions = this.store.data.subscriptions.filter(s => s.endpoint !== subscription.endpoint);
          }
        }
        message.pushAccepted = [...sent];
        message.attempts++;
        message.pushStatus = subscriptions.every(s => sent.has(s.endpoint)) ? "accepted" : message.attempts >= 5 ? "failed" : "pending";
        message.pushError = lastError;
        message.retryAt = new Date(Date.now() + Math.min(3600000, 60000 * 2 ** message.attempts)).toISOString();
        this.store.save(); this.changed();
      }
    } finally { this.sending = false; }
  }
}
module.exports = { Notifications };
