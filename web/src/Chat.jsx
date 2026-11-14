import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AssistantRuntimeProvider, useExternalStoreRuntime, useAuiState, ThreadPrimitive, MessagePrimitive, ComposerPrimitive, ActionBarPrimitive, AttachmentPrimitive, MessageNotSentError } from '@assistant-ui/react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import RunProgress from './RunProgress';
import { ArrowUp, ArrowDown, Paperclip, Square, Copy, X, Sparkles, Bell, LoaderCircle } from 'lucide-react';
import { api, Button, Form, Field, fmt, labels, useWorkbench, Empty } from './shared';

function readImage(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); }); }
function createAttachmentAdapter(toast) { return {
  accept: 'image/png,image/jpeg,image/webp',
  async add({ file }) {
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请使用 PNG、JPEG 或 WebP 图片');
      if (file.size > 8 * 1024 * 1024) throw new Error('每张图片最多 8 MB');
      return { id: crypto.randomUUID(), type: 'image', name: file.name, file, contentType: file.type,
        content: [{ type: 'image', image: await readImage(file) }], status: { type: 'requires-action', reason: 'composer-send' } };
    } catch (error) { toast(error.message, true); throw error; }
  },
  async send(attachment) { return { ...attachment, status: { type: 'complete' } }; },
  async remove() {},
}; }
function convertMessage(message) {
  return { id: message.id, role: message.role === 'system' ? 'assistant' : message.role,
    content: [{ type: 'text', text: message.text || '' }], createdAt: new Date(message.createdAt),
    ...(message.role !== 'user' ? { status: message.streaming ? { type: 'running' } : { type: 'complete', reason: 'stop' } } : {}),
    attachments: message.role === 'user' ? (message.images || []).map(image => ({ id: image.id, name: image.name, type: 'image', status: { type: 'complete' }, content: [{ type: 'image', image: `/api/chat-image?id=${encodeURIComponent(image.id)}` }] })) : [],
    metadata: { custom: { kind: message.kind, delivery: message.delivery, steps: message.steps, streaming: message.streaming } },
  };
}
function ImageAttachment({ removable = false }) {
  const attachment = useAuiState(s => s.attachment);
  const url = attachment.content?.find(part => part.type === 'image')?.image;
  return <AttachmentPrimitive.Root className="attachment">
    {url && <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={attachment.name}/></a>}
    <span>{attachment.name}</span>{removable && <AttachmentPrimitive.Remove className="attachment-remove" aria-label="移除图片"><X size={14}/></AttachmentPrimitive.Remove>}
  </AttachmentPrimitive.Root>;
}
const DraftAttachment = () => <ImageAttachment removable/>;
const Markdown = () => <MarkdownTextPrimitive className="markdown" smooth={false} remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer"/> }}/>;
function Message() {
  const message = useAuiState(s => s.message);
  const user = message.role === 'user', meta = message.metadata.custom || {};
  const name = user ? '你' : meta.kind === 'proactive' ? '主动消息' : meta.kind === 'reminder' ? '到点提醒' : meta.kind === 'error' ? '运行提示' : 'CyberBoss';
  return <MessagePrimitive.Root className={`chat-message ${user ? 'from-user' : 'from-agent'} ${meta.kind || ''}`} id={`message-${message.id}`}>
    {!user && <div className="message-avatar">{['proactive','reminder'].includes(meta.kind) ? <Bell size={17}/> : <Sparkles size={17}/>}</div>}
    <div className="message-content"><div className="message-meta"><strong>{name}</strong><time>{fmt(message.createdAt)}</time></div>
      <div className="message-bubble"><MessagePrimitive.Parts components={user ? {} : { Text: Markdown }}/><div className="attachments"><MessagePrimitive.Attachments components={{ Attachment: ImageAttachment }}/></div>
        {meta.streaming && !message.content.some(p => p.type === 'text' && p.text) && <div className="thinking" role="status"><span/><span/><span/>正在思考…</div>}
      </div>
      {meta.steps?.length > 0 && <details className="steps"><summary>查看执行过程 · {meta.steps.length} 步</summary>{meta.steps.map((step,i) => <div key={i}><span>{step.name}</span><small>{step.status}</small></div>)}</details>}
      {meta.delivery && <small className="delivery">{meta.delivery}</small>}
      {!meta.streaming && <ActionBarPrimitive.Root className="message-actions"><ActionBarPrimitive.Copy className="icon-button" title="复制消息" aria-label="复制消息"><Copy size={14}/></ActionBarPrimitive.Copy></ActionBarPrimitive.Root>}
    </div>
  </MessagePrimitive.Root>;
}
function Approval({ approval }) {
  const { refresh } = useWorkbench();
  return <div className="approval"><h3>这一步需要你处理</h3><pre>{approval.command || approval.reason || approval.params?.message || approval.method}</pre>
    {approval.method === 'item/tool/requestUserInput' ? <Form submit="提交回答" onSave={async data => {
      const answers = Object.fromEntries((approval.params.questions || []).map(q => [q.id, { answers: [data.get(q.id)] }]));
      await api('approval', { id: approval.requestId, answers }); await refresh();
    }}>{(approval.params.questions || []).map(q => <Field key={q.id} label={q.question}>
      <input name={q.id} list={`answers-${q.id}`} required/><datalist id={`answers-${q.id}`}>{(q.options || []).map(o => <option key={o.label} value={o.label}/>)}</datalist></Field>)}</Form>
      : <div className="actions"><Button className="primary" onClick={async () => { await api('approval', { id: approval.requestId, accept:true }); await refresh(); }}>允许这一次</Button><Button onClick={async () => { await api('approval', { id: approval.requestId, accept:false }); await refresh(); }}>拒绝</Button></div>}
  </div>;
}
export default function Chat({ active }) {
  const { state, connected, refresh, toast, draft, clearDraft, openMessage } = useWorkbench();
  const [sending, setSending] = useState(false), [stopping, setStopping] = useState(false), [inbox, setInbox] = useState(false);
  const submitted = useRef(null);
  const activeRun = state.runs.findLast(r => r.status === 'running' && !r.background);
  const running = sending || state.pendingChats.length > 0 || (state.agent.busy && !state.agent.background);
  const messages = useMemo(() => {
    const items = state.messages.map(message => {
      const run = state.runs.find(r => r.queueId === message.id);
      return { ...message, delivery: state.pendingChats.includes(message.id) ? '排队中' : run ? labels[run.status] || run.status : '', steps: run?.steps };
    });
    if (state.agent.busy && !state.agent.background) items.push({ id:`stream-${state.agent.startedAt}`, role:'assistant', text:state.agent.text, createdAt:state.agent.startedAt, streaming:true });
    return items;
  }, [state.messages, state.runs, state.pendingChats, state.agent]);
  const adapter = useMemo(() => createAttachmentAdapter(toast), [toast]);
  const runtime = useExternalStoreRuntime({ messages, convertMessage, isRunning:running, isSendDisabled:!connected || running,
    adapters:{ attachments:adapter },
    onNew:async message => {
      const images = (message.attachments || []).map(a => ({ name:a.name, data:a.content.find(p => p.type === 'image')?.image?.split(',')[1] }));
      const payload = { text:message.content.filter(p => p.type === 'text').map(p => p.text).join('\n'), images };
      if (images.length > 4 || (message.attachments || []).reduce((n,a) => n + (a.file?.size || 0),0) > 20*1024*1024) {
        toast('每次最多 4 张图片，总计不超过 20 MB', true); throw new MessageNotSentError('图片超出限制');
      }
      const signature = JSON.stringify(payload);
      if (submitted.current?.signature !== signature) submitted.current = { signature, requestId:crypto.randomUUID() };
      setSending(true);
      try {
        await api('chat', { ...payload, requestId:submitted.current.requestId });
        submitted.current = null;
      } catch (error) {
        setSending(false); toast(`${error.message}。内容已保留，可重试发送。`, true); throw new MessageNotSentError(error.message);
      }
      // A refresh failure after accepted POST must never restore and resend a successful message.
      try { await refresh(); } finally { setSending(false); }
    },
    onCancel:async () => { setStopping(true); try { await api('chat/cancel', {}); await refresh(); } catch(error) { toast(error.message,true); } finally { setStopping(false); } },
  });
  useEffect(() => { if (draft) { runtime.thread.composer.setText(draft); clearDraft(); } }, [draft, runtime, clearDraft]);
  const notices = state.messages.filter(m => ['proactive','reminder'].includes(m.kind)).slice(-40).reverse();
  return <div className="chat-page" hidden={!active}>
    <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="thread">
      <div className="chat-topbar"><span><span className={`status-dot ${running ? 'working' : ''}`}/>{state.agent.approvals.length ? '等待你的处理' : running ? state.pendingChats.length && state.agent.background ? '等待后台任务结束' : '正在回复' : '随时可以开始'}</span><Button onClick={() => setInbox(!inbox)}><Bell size={16}/>提醒箱 {notices.filter(m=>m.unread).length || ''}</Button></div>
      <ThreadPrimitive.Viewport className="thread-viewport">
        {!messages.length && <div className="chat-welcome"><div className="welcome-icon"><Sparkles size={28}/></div><h2>一起把事情理清楚。</h2><p>聊聊计划、贴一张截图，或让我帮你跟进一件事。</p><div className="suggestions">{['看看最近还有什么没做的事','帮我安排接下来的一小时','帮我记住一件事'].map(text => <button key={text} className="secondary" onClick={() => runtime.thread.composer.setText(text)}>{text}</button>)}</div></div>}
        <ThreadPrimitive.Messages components={{ UserMessage:Message, AssistantMessage:Message, SystemMessage:Message }}/>
        {sending && <p className="chat-progress"><LoaderCircle size={16} className="spin"/>正在发送…</p>}
        {!sending && state.pendingChats.length > 0 && <p className="chat-progress"><LoaderCircle size={16} className="spin"/>消息已收到，正在等待执行</p>}
        {activeRun && <RunProgress run={activeRun}/>}
        {state.agent.approvals.map(a => <Approval key={a.requestId} approval={a}/>)}
      </ThreadPrimitive.Viewport>
      <div className="composer-dock"><ThreadPrimitive.ScrollToBottom className="scroll-latest secondary" aria-label="回到最新消息"><ArrowDown size={16}/>最新消息</ThreadPrimitive.ScrollToBottom>
        <ComposerPrimitive.Root className="composer"><ComposerPrimitive.AttachmentDropzone className="composer-dropzone">
          <div className="attachments"><ComposerPrimitive.Attachments components={{ Attachment:DraftAttachment }}/></div>
          <ComposerPrimitive.Input className="composer-input" placeholder="发消息，或粘贴、拖入截图…" aria-label="消息内容" rows={1} maxRows={8} maxLength={50000} submitMode="enter"/>
          <div className="composer-actions"><ComposerPrimitive.AddAttachment className="icon-button" title="添加图片" aria-label="添加图片"><Paperclip size={19}/></ComposerPrimitive.AddAttachment><small>Enter 发送 · Shift+Enter 换行</small><span className="spacer"/>
            {running ? <ComposerPrimitive.Cancel className="send-button" disabled={sending || stopping} aria-label="停止回复" title="停止回复">{stopping ? <LoaderCircle size={18} className="spin"/> : <Square size={16}/>}</ComposerPrimitive.Cancel> : <ComposerPrimitive.Send className="send-button" aria-label="发送消息" title="发送消息"><ArrowUp size={20}/></ComposerPrimitive.Send>}
          </div>
        </ComposerPrimitive.AttachmentDropzone></ComposerPrimitive.Root><p className="composer-caption">{!connected ? '本机服务未连接，草稿保留在当前页面' : state.agent.background ? 'Agent 正在后台工作，消息会接着处理' : '图片与对话保存在这台电脑 · 支持 PNG / JPEG / WebP'}</p>
      </div>
    </ThreadPrimitive.Root></AssistantRuntimeProvider>
    {inbox && <aside className="inbox"><div className="section-heading"><h2>提醒箱</h2><button className="icon-button" aria-label="关闭提醒箱" onClick={() => setInbox(false)}><X size={18}/></button></div><p className="muted">只有值得告诉你的事才会出现在这里。</p>{notices.length ? notices.map(m => <Button key={m.id} className={`notice ${m.unread ? 'unread' : ''}`} onClick={() => openMessage(m.id)}><span>{m.text.slice(0,160)}</span><small>{fmt(m.createdAt)} · {m.unread ? '未读' : '已读'}{m.pushStatus === 'failed' ? ' · 推送失败，消息已保留' : ''}</small></Button>) : <Empty>有新提醒时会留在这里。</Empty>}</aside>}
  </div>;
}
