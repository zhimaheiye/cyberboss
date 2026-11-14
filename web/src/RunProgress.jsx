import React, { useEffect, useState } from 'react';
import { LoaderCircle, Clock3, CircleAlert } from 'lucide-react';
import { api, Badge, useWorkbench } from './shared';

function duration(ms) { if (!Number.isFinite(ms)) return '未知'; const s = Math.max(0, Math.floor(ms/1000)); return s < 60 ? `${s} 秒` : `${Math.floor(s/60)} 分 ${s%60} 秒`; }
function timestamp(value) { return value ? new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value)) : '未记录'; }
const phases = { connecting:'正在连接 Codex',model:'等待 Agent 下一步输出',tool:'正在等待工具返回',approval:'等待你的批准或回答',response:'Agent 正在输出',finished:'本轮已结束' };
export default function RunProgress({ run, expanded = false }) {
  const { connected }=useWorkbench(); const [open,setOpen]=useState(expanded),[detail,setDetail]=useState(null),[error,setError]=useState(''),[now,setNow]=useState(Date.now());
  useEffect(()=>{if(run.status!=='running')return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[run.status]);
  useEffect(()=>{
    if(!open)return;let disposed=false;
    api(`run?id=${encodeURIComponent(run.id)}`).then(data=>{if(!disposed){setDetail(data);setError(data?'':'找不到这条执行记录');}}).catch(e=>{if(!disposed)setError(e.message);});
    return()=>{disposed=true;};
  },[open,run.id,run.updatedAt,run.status,connected]);
  const running=run.status==='running', current=run.steps?.filter(s=>s.status==='running')||[], lastAt=run.progress?.lastEventAt||run.steps?.at(-1)?.at||run.createdAt;
  const elapsed=(running?now:Date.parse(run.finishedAt))-Date.parse(run.createdAt), idle=now-Date.parse(lastAt);
  return <section className="run-progress-panel">
    <div className="run-metrics"><span><Clock3 size={14}/>总用时 {duration(elapsed)}</span>{running&&<span>最近活动 {duration(idle)} 前</span>}{!connected&&running&&<span>连接已断开，状态可能过期</span>}</div>
    {running&&<div className="run-current" role="status"><LoaderCircle size={15} className="spin"/><div><strong>{run.progress?.phase==='approval'?phases.approval:current.length?`正在执行：${current.map(s=>s.name).join('、')}`:phases[run.progress?.phase]||'执行中（旧版未记录当前步骤）'}</strong>{current.map(s=><p key={s.id}>{s.summary||s.name} · {duration(now-Date.parse(s.startedAt))}</p>)}</div></div>}
    {running&&idle>60000&&<p className="progress-warning"><CircleAlert size={14}/>已超过 1 分钟没有新事件；可能在等待工具或模型，不代表已经确认卡死。</p>}
    {run.latestUpdate&&<p className="run-latest">{run.latestUpdate}</p>}
    <details open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>执行详情 · {run.steps?.length||0} 步{run.omittedSteps?`（更早 ${run.omittedSteps} 步已省略）`:''}</summary>
      {error&&<div className="alert error">{error}</div>}
      {detail?<>{detail.detailSource==='codex-session'&&<p className="hint">从本机 Codex 会话还原的调用记录，包含 exec / wait 等等待环节；不会覆盖原执行数据。</p>}{detail.detailNote&&<p className="hint">{detail.detailNote}</p>}<div className="step-list">{(detail.steps||[]).map((s,i)=><details className="step-detail" key={s.id||`${s.at}-${i}`}><summary><Badge value={s.status}/><span className="step-title">{s.name}<small>{s.summary||'旧记录未保存操作参数'}</small></span><small>{timestamp(s.startedAt||s.at)} · {s.startedAt?duration(s.durationMs??(s.status==='running'?now-Date.parse(s.startedAt):NaN)):'耗时未记录'}</small></summary>
        {s.error&&<div className="alert error">{s.error}</div>}{s.transportStatus&&s.transportStatus!==s.status&&<p className="muted">工具调用状态：{s.transportStatus}；返回内容报告失败。</p>}
        {s.input&&<><h4>输入 / 操作内容</h4><pre>{s.input}</pre></>}{s.output&&<><h4>输出 / 返回结果</h4><pre>{s.output}</pre></>}
        {!s.input&&!s.output&&<p className="muted">这一条来自旧版记录，未保存参数和结果，无法从此记录恢复。</p>}
        {s.exitCode!=null&&<p className="muted">退出码：{s.exitCode}</p>}
      </details>)}</div>{detail.updates?.length>0&&<details className="agent-updates"><summary>Agent 的过程说明与输出 · {detail.updates.length} 条</summary>{detail.updates.map(u=><article key={u.id}><small>{timestamp(u.at)} · {u.phase==='commentary'?'过程说明':'输出'}</small><p>{u.text}</p></article>)}</details>}
      <p className="progress-footnote">记录展示操作与工具结果，不包含模型私有推理。敏感字段会遮盖，长内容会截断。执行完成不等于业务操作成功。</p></>:!error&&<p className="muted">正在读取详细记录…</p>}
    </details>
  </section>;
}
