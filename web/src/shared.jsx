import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { LoaderCircle, X, Inbox } from 'lucide-react';

export const Workbench = createContext(null);
export const useWorkbench = () => useContext(Workbench);
export async function api(route, body, options = {}) {
  const response = await fetch(`/api/${route}`, { ...options, method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Cyberboss': 'desktop', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '操作失败'), { status: response.status });
  return data;
}
export const tool = (name, args) => api('tool', { name, args });
export const labels = { reminder:'到点提醒', watch:'信息监控', operation:'后台作业', opportunity:'机会式事项', active:'已启用', draft:'待接管', paused:'已暂停', blocked:'需要处理', done:'已结束', completed:'已完成', failed:'失败', interrupted:'中断', cancelled:'已取消', running:'执行中', yielded:'等待后续返回', unknown:'结果未确认', notified:'已入提醒箱', acknowledged:'已确认处理', user:'你的自述', observed:'设备观察', inferred:'推断' };
export function fmt(value) { return value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(value)) : '—'; }
export function localDate(value = new Date()) { const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date(value)); return ['year','month','day'].map(k => parts.find(p => p.type === k).value).join('-'); }
export const titleOf = t => t.untrusted_text?.title || t.title || '未命名待办';
export const descriptionOf = t => t.untrusted_text?.description || t.description || '';
export function Empty({ children, title = '这里暂时没有内容' }) { return <div className="empty"><Inbox size={26}/><strong>{title}</strong><p>{children}</p></div>; }
export function Badge({ value, children }) { return <span className={`badge ${value || ''}`}>{children || labels[value] || value}</span>; }
export function Button({ onClick, children, className = 'secondary', ...props }) {
  const [busy, setBusy] = useState(false); const { toast } = useWorkbench();
  return <button type="button" {...props} className={className} disabled={busy || props.disabled} onClick={async event => {
    if (!onClick || busy) return; setBusy(true);
    try { await onClick(event); } catch (error) { toast(error.message, true); } finally { setBusy(false); }
  }}>{busy ? <LoaderCircle size={16} className="spin"/> : null}{children}</button>;
}
export function Field({ label, hint, children, ...props }) { return <label className="field"><span>{label}</span>{children || <input {...props}/>}{hint && <small>{hint}</small>}</label>; }
export function Form({ onSave, children, submit = '保存', className = '', footer }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <form className={`form ${className}`} onSubmit={async e => { e.preventDefault(); if(busy) return;
    const data = new FormData(e.currentTarget); setBusy(true); setError('');
    try { await onSave(data, e.currentTarget); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }}><fieldset disabled={busy}>{children}</fieldset>{error && <div className="alert error" role="alert">{error}</div>}
    <div className="form-actions">{footer}<button type="submit" disabled={busy}>{busy && <LoaderCircle size={16} className="spin"/>}{busy ? '正在处理…' : submit}</button></div></form>;
}
export function Dialog({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => { const dialog = ref.current; const previous = document.activeElement; dialog.showModal(); return () => { dialog.close(); previous?.focus?.(); }; }, []);
  return <dialog ref={ref} className={wide ? 'wide' : ''} onCancel={e => { e.preventDefault(); onClose(); }} aria-label={title}>
    <div className="dialog-header"><h2>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={20}/></button></div><div className="dialog-body">{children}</div></dialog>;
}
export async function openTaskBoard() {
  const tab = window.open('about:blank', 'cyberboss-tasks');
  try { const { url } = await api('opentodo/open', {}); if (tab) tab.location = url; else location.href = url; } catch (error) { tab?.close(); throw error; }
}
