import { api } from './shared';
let registration, enabling;
export async function setupNotifications() {
  if ('serviceWorker' in navigator) { await navigator.serviceWorker.register('/sw.js'); registration = await navigator.serviceWorker.ready; }
}
export function notificationLabel() {
  if (!window.Notification || !('serviceWorker' in navigator)) return '此浏览器不支持提醒';
  return { granted: '桌面提醒已开启', denied: '提醒被浏览器阻止', default: '允许桌面提醒' }[Notification.permission];
}
export async function enableNotifications(key, ask = false) {
  if (enabling) return enabling;
  enabling = (async () => {
    if (!window.Notification) return '此浏览器不支持提醒';
    // Request in the trusted click before waiting for service-worker startup.
    const permission = Notification.permission === 'default' && ask ? await Notification.requestPermission() : Notification.permission;
    if (permission !== 'granted') return notificationLabel();
    if (!key) return '桌面提醒已开 · 等待本机连接';
    if (!registration) await setupNotifications();
    try {
      if (!('PushManager' in window)) return '桌面提醒已开 · 页面运行时';
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const encoded = key.replace(/-/g, '+').replace(/_/g, '/');
        const bytes = Uint8Array.from(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)), c => c.charCodeAt(0));
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      }
      await api('push', subscription.toJSON()); return '桌面提醒已开启';
    } catch { return '桌面提醒已开 · 页面运行时'; }
  })();
  try { return await enabling; } finally { enabling = null; }
}
export function deliverNotifications(state) {
  if (state.breathing?.active || !registration?.active || window.Notification?.permission !== 'granted') return;
  for (const message of state.messages.filter(m => m.unread && !m.breathingSessionId && m.pushStatus !== 'cancelled' && ['proactive', 'reminder'].includes(m.kind))) {
    if (message.kind === 'proactive' && state.quiet) continue;
    const job = state.jobs.find(j => j.id === message.jobId);
    if (job && (job.status !== 'active' || Date.parse(job.suppressUntil) > Date.now() || Date.parse(job.activeUntil) < Date.now() || Date.parse(job.activeFrom) > Date.now())) continue;
    registration.active.postMessage({ type: 'notify', message: { id: message.id, title: message.kind === 'reminder' ? 'CyberBoss · 到点提醒' : 'CyberBoss · 有事告诉你', body: message.text.slice(0, 500) } });
  }
}
