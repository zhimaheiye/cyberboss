import React, { useEffect, useRef, useState } from 'react';
import { api, Button, Dialog, Field, Form, localDate, titleOf, useWorkbench } from './shared';
import { SourceViewer, sourceNames } from './Search';
import PlaybookEditor, { makeMethod } from './PlaybookEditor';
import StartActions, { FiveMinutes } from './StartActions';

const endpoint = 'procrastination';
function rank(reason, stats) {
  function score(method) {
    const counts=stats[reason.id+'/'+method.id] || {};
    return ((counts.started||0)+1)/((counts.started||0)+(counts.stuck||0)+2);
  }
  return reason.strategies.filter(s=>s.enabled).sort((a,b)=>score(b)-score(a)||Number(b.personal)-Number(a.personal));
}
function ResourceList({reason,subject,taskId,saveReason,report}) {
  const [result,setResult]=useState(null),[error,setError]=useState('');
  const [query,setQuery]=useState(subject),[term,setTerm]=useState(subject);
  const [viewing,setViewing]=useState(null),[retry,setRetry]=useState(0);
  const pins=reason.pins.join('\n');
  useEffect(()=>{
    let alive=true;setResult(null);setError('');report([]);
    api(endpoint,{action:'resources',reasonId:reason.id,taskId,query:term}).then(data=>{
      if(alive){setResult(data);report(data.items);}
    }).catch(e=>{if(alive)setError(e.message);});
    return ()=>{alive=false;};
  },[reason.id,taskId,term,pins,retry,report]);
  return <section className="panel"><h3>手边的资源</h3>
    <form className="filter-bar" onSubmit={e=>{e.preventDefault();setTerm(query.trim());setRetry(n=>n+1);}}>
      <input aria-label="查找相关资源" placeholder="输入材料、工具或笔记的关键词" value={query} maxLength={500} onChange={e=>setQuery(e.target.value)}/><button>查找</button>
    </form>
    {error&&<p className="alert error">{error}</p>}
    {!result&&!error&&<small role="status">正在读取本机资源…</small>}
    {result?.warnings.map(w=><p key={w} className="muted">{w}</p>)}
    {result&&!result.items.length&&<p className="muted">{term?'没有找到相关记录，可以换个关键词。':'可以查一个关键词，或直接开始上面的动作。'}</p>}
    {result?.items.map(item=><article key={item.ref} className="start-resource"><div>
      <small>{sourceNames[item.source]}{reason.pins.includes(item.ref)?' · 已固定':''}</small><h4>{item.title}</h4>
      <p className="line-clamp">{item.snippet}</p></div><div className="actions"><Button onClick={()=>setViewing(item.ref)}>打开</Button>
      <Button onClick={()=>saveReason({...reason,pins:reason.pins.includes(item.ref)?reason.pins.filter(ref=>ref!==item.ref):[...reason.pins,item.ref]})}>{reason.pins.includes(item.ref)?'取消固定':'以后也推荐'}</Button></div>
    </article>)}
    {viewing&&<SourceViewer sourceRef={viewing} close={()=>setViewing(null)}/>}
  </section>;
}
function Usage({book}) {
  const rows=book.reasons.flatMap(r=>r.strategies.map(s=>({reason:r.title,method:s.label,counts:book.stats[r.id+'/'+s.id]}))).filter(row=>row.counts);
  return <details className="panel"><summary>我的使用反馈</summary>
    {rows.length?<ul>{rows.map((r,i)=><li key={i}>{r.reason} · {r.method} — 开始了 {r.counts.started} 次，仍然卡住 {r.counts.stuck} 次，改期或转交 {r.counts.deferred} 次</li>)}</ul>
      :<p className="muted">选择行动后的反馈，就会在这里看到记录。</p>}
  </details>;
}

export default function Procrastination({active,entry,startBreathing}) {
  const {tasks,toast}=useWorkbench();
  const [book,setBook]=useState(null),[loadError,setLoadError]=useState(''),[reload,setReload]=useState(0);
  const [taskId,setTaskId]=useState(entry?.task?.id||''),[subject,setSubject]=useState(entry?.task?titleOf(entry.task):'');
  const [reasonId,setReasonId]=useState(''),[methodId,setMethodId]=useState(''),[level,setLevel]=useState(0);
  const [editing,setEditing]=useState(false),[custom,setCustom]=useState(false),[override,setOverride]=useState('');
  const [resources,setResources]=useState([]),[recorded,setRecorded]=useState(false);
  const feedbackId=useRef(crypto.randomUUID());
  useEffect(()=>{
    if(!active)return;
    let alive=true;setLoadError('');
    api(endpoint).then(data=>{if(alive)setBook(data);}).catch(e=>{if(alive)setLoadError(e.message);});
    return()=>{alive=false;};
  },[active,reload]);
  const today=localDate();
  const soon=tasks.filter(t=>!t.completed&&t.due?.date&&t.due.date<=today).sort((a,b)=>a.due.date.localeCompare(b.due.date));
  const task=tasks.find(t=>t.id===taskId)||((entry?.task?.id===taskId)&&entry.task)||null;
  const reason=book?.reasons.find(r=>r.id===reasonId&&r.enabled);
  const methods=reason?rank(reason,book.stats):[];
  const method=methods.find(s=>s.id===methodId);
  const step=override||method?.steps[Math.min(level,method.steps.length-1)]||'';
  function resetFeedback() {feedbackId.current=crypto.randomUUID();setRecorded(false);}
  function chooseMethod(id) {setMethodId(id);setLevel(0);setOverride('');resetFeedback();}
  function chooseReason(id) {
    setReasonId(id);chooseMethod('');setResources([]);
    const r=book.reasons.find(item=>item.id===id);
    const options=r&&rank(r,book.stats);
    if(options?.length===1)chooseMethod(options[0].id);
  }
  function chooseTask(t) {setTaskId(t?.id||'');setSubject(t?titleOf(t):'');}
  async function saveReason(updated) {
    const next=await api(endpoint,{action:'save',revision:book.revision,reasons:book.reasons.map(r=>r.id===updated.id?updated:r)});
    setBook(next);
  }
  async function feedback(outcome) {
    if(recorded)return;
    const stats=await api(endpoint,{action:'feedback',id:feedbackId.current,reasonId,strategyId:method.id,
      outcome,subject:subject.slice(0,500),taskId,step});
    setBook(current=>({...current,stats}));setRecorded(true);
    if(outcome==='stuck'&&methods.length>1){
      chooseMethod(methods[(methods.findIndex(s=>s.id===method.id)+1)%methods.length].id);
      toast('已换一个方法');
    } else toast('反馈已记下');
  }
  if(!book&&!active)return null;
  return <section hidden={!active} className="start-guide">
    <div className="page-toolbar"><p>{subject&&reason?'当前事项 · '+subject:'选一个最接近此刻感觉的卡点。'}</p>
      <div className="actions">{reason&&<Button onClick={()=>chooseReason('')}>重选卡点</Button>}
        <Button disabled={!book} onClick={()=>setEditing(true)}>编辑速查表</Button></div></div>
    {loadError&&<p className="alert error">{loadError} <Button onClick={()=>setReload(n=>n+1)}>重新读取</Button></p>}
    {!book&&!loadError&&<p role="status">正在打开速查表…</p>}
    {book&&!reason&&<>
      <section className="panel"><Field label="这次想做的事（可留空）"><input value={subject} maxLength={500}
        placeholder="写一句话，或直接选下面的卡点" onChange={e=>{setTaskId('');setSubject(e.target.value);}}/></Field>
        {(soon.length>0||task)&&<Field label="从待办中选择"><select value={taskId} onChange={e=>chooseTask(tasks.find(t=>t.id===e.target.value))}>
          <option value="">选择今天或已逾期的待办</option>{(task&&!soon.some(t=>t.id===task.id)?[task,...soon]:soon).map(t=><option key={t.id} value={t.id}>{t.due?.date} · {titleOf(t)}</option>)}
        </select></Field>}
      </section><div className="start-choices">{book.reasons.filter(r=>r.enabled).map(r=><Button key={r.id} onClick={()=>chooseReason(r.id)}>{r.title}</Button>)}</div>
      <Usage book={book}/>
    </>}
    {reason&&!method&&<section className="panel"><small>{reason.title}</small><h2>{reason.question||'想先试试哪种做法？'}</h2>
      <div className="start-choices">{methods.map(s=><Button key={s.id} onClick={()=>chooseMethod(s.id)}>{s.label}
        {book.stats[reason.id+'/'+s.id]?.started>0&&<small>开始过 {book.stats[reason.id+'/'+s.id].started} 次</small>}</Button>)}</div>
    </section>}
    {reason&&method&&<><section className="panel start-step">
      <small>{reason.title} · {method.label}</small><h2>现在这一步</h2><p className="start-instruction">{step}</p>
      <div className="actions">
        <Button onClick={()=>{if(!override&&level+1<method.steps.length){setLevel(level+1);resetFeedback();}else setCustom(true);}}>再拆小一点</Button>
        <Button onClick={()=>setCustom(true)}>改成我的做法</Button>
        {methods.length>1&&<Button onClick={()=>chooseMethod('')}>换个方法</Button>}
      </div><FiveMinutes/>
      <StartActions key={method.id+level+step} task={task} subject={subject} step={step} hint={override?'':method.steps[level+1]} reason={reason} resources={resources} soon={soon} startBreathing={startBreathing}/>
      <div className="start-feedback"><small>{recorded?'这次反馈已记录':'这次怎么样？'}</small><div className="actions">
        <Button disabled={recorded} onClick={()=>feedback('started')}>开始动了</Button><Button disabled={recorded} onClick={()=>feedback('stuck')}>还是卡住</Button>
        <Button disabled={recorded} onClick={()=>feedback('deferred')}>改期或转交了</Button></div></div>
    </section><ResourceList key={reason.id+taskId+subject} reason={reason} subject={subject} taskId={taskId} saveReason={saveReason} report={setResources}/></>}
    {editing&&<PlaybookEditor book={book} initialId={reason?.id} saved={next=>{setBook(next);setOverride('');setLevel(0);resetFeedback();}} close={()=>setEditing(false)}/>}
    {custom&&method&&<Dialog title="我的下一步" onClose={()=>setCustom(false)}><Form submit="使用这一步" onSave={async fields=>{
      const text=fields.get('step').trim();if(!text)throw new Error('写一个可以动手的动作');
      if(fields.get('keep')){
        const s={...makeMethod(),label:text.slice(0,60),steps:[text]};
        await saveReason({...reason,strategies:[...reason.strategies,s]});chooseMethod(s.id);
      } else {setOverride(text);resetFeedback();}
      setCustom(false);
    }}><Field label="具体动作"><textarea name="step" rows={3} defaultValue={step} maxLength={600} required/></Field>
      <label className="check"><input type="checkbox" name="keep" defaultChecked/>存为这个卡点的常用方法</label>
    </Form></Dialog>}
  </section>;
}
