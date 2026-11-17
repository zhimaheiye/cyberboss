import React, { useEffect, useRef, useState } from 'react';
import { api, Button, Dialog, Form, Field, fmt, useWorkbench } from './shared';
import RunProgress from './RunProgress';
import { SearchDialog } from './Search';
export function Decision({ value }) {
  if (!value) return null;
  const names = { silent:'保持静默', notified:'已加入提醒', handoff:'需要接手', suppressed:'提醒暂缓', retry:'等待重新核验', failed:'执行未完成', cancelled:'已停止' };
  return <div className="hint"><strong>{names[value.outcome] || value.outcome}</strong><p>{value.reason}</p>{value.suppression && <p>{value.suppression}</p>}</div>;
}
export default function WorkDetail({ jobId, close }) {
  const { state, refresh } = useWorkbench(), job = state.jobs.find(j => j.id === jobId);
  const [data, setData] = useState(null), [error, setError] = useState(''), [editing, setEditing] = useState(false), [kind, setKind] = useState('reference');
  const inputKey = useRef(crypto.randomUUID());
  const [inputText,setInputText] = useState('');
  const [target,setTarget] = useState(''), [choosing,setChoosing] = useState(false);
  const revision = state.work?.[jobId];
  async function load() { const result = await api(`work?jobId=${encodeURIComponent(jobId)}`); setData(result); setError(''); }
  useEffect(() => { let disposed = false; api(`work?jobId=${encodeURIComponent(jobId)}`).then(r => { if (!disposed) { setData(r); setError(''); } }).catch(e => { if (!disposed) setError(e.message); }); return () => { disposed = true; }; }, [jobId, revision?.version, revision?.lastRunAt, revision?.pendingEvents, JSON.stringify(revision?.subscriptionErrors)]);
  const progress = data?.progress, latest = state.runs.findLast(r => r.jobId === jobId);
  return <Dialog title={job?.title || '托管事项'} onClose={close} wide>
    {error && <div className="alert error">{error}<Button onClick={load}>重新读取</Button></div>}
    {!data ? <p>正在读取进展…</p> : <div className="work-detail">
      <section><h3>当前进展</h3><p className="preserve-lines">{progress.summary || '首次运行后，Agent 会在有实质进展时保存摘要。'}</p>
        <small>{progress.updatedAt ? `更新于 ${fmt(progress.updatedAt)} · Agent 记录` : '尚未记录进展'}</small>
        {progress.facts?.length > 0 && <details><summary>已确认的信息 · {progress.facts.length}</summary><ul>{progress.facts.map((f,i) => <li key={i}>{f.text}{f.source && <small className="preserve-lines">来源：{f.source}</small>}</li>)}</ul></details>}
        {progress.openQuestions?.length > 0 && <><h4>仍待核验</h4><ul>{progress.openQuestions.map((q,i) => <li key={i}>{q}</li>)}</ul></>}
        {progress.nextStep && <p><strong>下一步：</strong>{progress.nextStep}</p>}
        {progress.waitingFor && <div className={progress.needsUser ? 'alert' : 'hint'}>{progress.needsUser ? '需要你处理：' : '等待：'}{progress.waitingFor}</div>}
        {progress.lastError && <div className="alert error">{progress.lastError}</div>}
        {job?.verificationRetry?.at && <p>下次核验重试：{fmt(job.verificationRetry.at)}</p>}
        <Decision value={progress.notificationDecision}/>
      </section>
      <section><h3>补充说明</h3><Form submit="保存补充" onSave={async d => {
        await api('work', { action:'input', jobId, text:d.get('text'), key:inputKey.current }); inputKey.current = crypto.randomUUID();
        setInputText(''); await load(); await refresh();
      }}><Field label="新的线索、要求或反馈"><textarea name="text" value={inputText} onChange={e=>{setInputText(e.target.value);inputKey.current=crypto.randomUUID();}} rows={3} required maxLength={6000}/></Field>
        <p className="hint">内容会保留原话和时间。启用中的事项在当前执行结束后接收；暂停、阻塞或静默期间先保留，按原状态等待处理。</p></Form>
      </section>
      <section><div className="section-heading"><h3>哪些变化触发跟进</h3><Button onClick={() => setEditing(!editing)}>{editing ? '收起' : '添加来源'}</Button></div>
        <p className="hint">首次读取建立基线，之后每分钟检查变化。外部事件由连接的工具或程序推送。</p>
        {data.subscriptions.map(s => <article className="work-subscription" key={s.id}><strong>{{reference:'工作台记录',file:'本地文件',event:'外部事件'}[s.kind]}</strong><p className="preserve-lines">{s.target}</p>{s.condition && <p>跟进要求：{s.condition}</p>}<small>上次检查 {fmt(s.checkedAt)}</small>{s.error && <div className="alert error">{s.error}</div>}
          <Button onClick={async () => { await api('work', { ...s, action:'subscribe', enabled:!s.enabled }); await load(); await refresh(); }}>{s.enabled ? '停用' : '启用'}</Button></article>)}
        {editing && <Form submit="添加订阅" onSave={async d => { await api('work', { action:'subscribe', jobId, kind, target:d.get('target'), condition:d.get('condition') }); await load(); await refresh(); setEditing(false); }}>
          <Field label="来源类型"><select value={kind} onChange={e => {setKind(e.target.value);setTarget('');}}><option value="reference">工作台记录</option><option value="file">本地文本文件</option><option value="event">外部事件</option></select></Field>
          <Field label={kind === 'file' ? '单个文件的绝对路径' : kind === 'event' ? '事件来源名称' : '工作台记录'}><div className="input-action"><input name="target" value={target} onChange={e=>setTarget(e.target.value)} required/>{kind==='reference'&&<Button onClick={()=>setChoosing(true)}>搜索选择</Button>}</div></Field>
          <Field label="变化后需要跟进什么"><textarea name="condition" rows={2} maxLength={2000}/></Field></Form>}
      </section>
      {latest && <section><h3>最近执行</h3><RunProgress run={latest}/></section>}
      <details><summary>进展与事件记录 · 最近 {data.events.length} 条</summary>{data.events.slice().reverse().map(e => <article className="work-event" key={e.id}><small>{fmt(e.createdAt)} · {e.actor === 'user' ? '你的补充' : e.kind === 'progress' ? 'Agent 进展' : '来源变化'}{e.delivery ? ` · ${{pending:'待处理',delivered:'已交给 Agent'}[e.delivery] || e.delivery}` : ''}{e.outcome ? ` · ${e.outcome}` : ''}</small><p className="preserve-lines">{e.progress?.summary || e.data?.text || e.data?.title || e.source}</p>{e.progress?.nextStep && <p>下一步：{e.progress.nextStep}</p>}<details><summary>保存的完整内容</summary><pre>{JSON.stringify(e.progress || e.data, null, 2)}</pre></details></article>)}</details>
    </div>}
    {choosing&&<SearchDialog close={()=>setChoosing(false)} choose={item=>{setTarget(item.ref);setChoosing(false);}}/>}
  </Dialog>;
}
