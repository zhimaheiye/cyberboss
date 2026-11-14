import React, { useState } from 'react';
import RunProgress from './RunProgress';
import { Plus, Download, Play, Pause, Pencil, CheckCheck, Clock3 } from 'lucide-react';
import { useWorkbench, api, tool, Button, Badge, Dialog, Form, Field, Empty, labels, fmt, localDate } from './shared';

const presets = {manual:'手动 / 事件触发',once:'一次性',hourly:'每小时整点',hours:'每隔若干小时',daily:'每天',weekly:'每周',monthly:'每月','month-end':'每月最后两天',interval:'每隔若干天',custom:'自定义周期规则'};
const rules = {hourly:'FREQ=HOURLY;BYMINUTE=0;BYSECOND=0',daily:'FREQ=DAILY',weekly:'FREQ=WEEKLY',monthly:'FREQ=MONTHLY','month-end':'FREQ=MONTHLY;BYMONTHDAY=-2,-1'};
function JobEditor({ job, close }) {
  const { refresh, toast }=useWorkbench(); const schedule=job.schedule||{type:'manual'};
  const hours=/^FREQ=HOURLY(?:;INTERVAL=(\d+))?$/.exec(schedule.rrule||'');
  const days=/^FREQ=DAILY;INTERVAL=(\d+)$/.exec(schedule.rrule||'');
  const initial=schedule.type==='recurring' ? Object.keys(rules).find(k=>rules[k]===schedule.rrule) || (hours?'hours':days?'interval':'custom') : schedule.type;
  const [preset,setPreset]=useState(initial),[kind,setKind]=useState(job.kind||'watch'),[gap,setGap]=useState(job.minimumGapMinutes??1440);
  const time=schedule.time || (schedule.at ? new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(schedule.at)) : '09:00');
  return <Dialog title={job.id?'编辑托管事项':'新建托管事项'} onClose={close} wide><Form onSave={async d=>{
    const date=d.get('startDate'), time=d.get('time')||'09:00';
    const next=preset==='manual'?{type:'manual'}:preset==='once'?{type:'once',at:new Date(`${date}T${time}:00+08:00`).toISOString()}:{type:'recurring',rrule:rules[preset]||(preset==='hours'?`FREQ=HOURLY;INTERVAL=${Number(d.get('hours'))}`:preset==='interval'?`FREQ=DAILY;INTERVAL=${Number(d.get('days'))}`:d.get('rrule')),time:preset==='hourly'?'00:00':time,startDate:date};
    await api('jobs/save',{...job,title:d.get('title'),kind,status:d.get('status'),instructions:d.get('instructions'),notificationText:d.get('notificationText')||job.notificationText||'',contexts:d.get('contexts'),taskId:d.get('taskId'),schedule:next,timezone:d.get('timezone'),minimumGapMinutes:Number(gap),activeFrom:d.get('activeFrom'),activeUntil:d.get('activeUntil'),suppressUntil:d.get('suppressUntil')});
    await refresh(); toast('托管事项已保存'); close();
  }}><Field label="事项名称" name="title" defaultValue={job.title||''} required maxLength={300}/><div className="field-pair"><Field label="工作方式"><select value={kind} onChange={e=>setKind(e.target.value)}>{['reminder','watch','operation','opportunity'].map(k=><option key={k} value={k}>{labels[k]}</option>)}</select></Field><Field label="状态"><select name="status" defaultValue={job.status||'draft'}>{['draft','active','paused','blocked','done'].map(k=><option key={k} value={k}>{labels[k]}</option>)}</select></Field></div>
    <Field label="具体要求、来源与执行边界"><textarea name="instructions" defaultValue={job.instructions||''} rows={5} maxLength={50000}/></Field>
    {kind==='reminder'&&<Field label="到点提醒内容" name="notificationText" defaultValue={job.notificationText||job.title||''}/>}
    <div className="form-section"><h3>运行时间</h3><Field label="什么时候检查或提醒"><select value={preset} onChange={e=>{setPreset(e.target.value);if(!job.id&&['hourly','hours'].includes(e.target.value)&&Number(gap)===1440)setGap(60);}}>{Object.entries(presets).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></Field>
      {preset!=='manual'&&<div className="field-pair"><Field label="日期 / 周期起点" name="startDate" type="date" defaultValue={schedule.startDate||(schedule.at?localDate(schedule.at):localDate())} required/>{preset!=='hourly'&&<Field label={preset==='once'?'时间（北京时间）':'时间（下方时区）'} name="time" type="time" defaultValue={time} required/>}</div>}
      {preset==='hourly'&&<p className="hint">每个整点检查一次，例如 10:00、11:00。电脑关机期间不运行。</p>}
      {preset==='hours'&&<Field label="间隔小时数" name="hours" type="number" min="1" max="10000" defaultValue={hours?.[1]||1} required/>}
      {preset==='interval'&&<Field label="间隔天数" name="days" type="number" min="1" max="10000" defaultValue={days?.[1]||40} required/>}
      {preset==='custom'&&<Field label="RRULE" name="rrule" defaultValue={schedule.rrule||''} required/>}
      <Field label="主动消息最小间隔（分钟）" hint="控制重复打扰；到点提醒按设定时间直接发送。"><input type="number" min="0" value={gap} onChange={e=>setGap(e.target.value)} required/></Field>
    </div>
    <details className="advanced" open={!!job.sourceFile}><summary>上下文与高级设置</summary><Field label="什么情境下可以顺手提起"><textarea name="contexts" rows={2} defaultValue={job.contexts||''}/></Field><Field label="关联待办 ID" name="taskId" defaultValue={job.taskId||''}/><Field label="周期时区" name="timezone" defaultValue={job.timezone||'Asia/Shanghai'}/><Field label="静默至（含时区日期时间，可留空）" name="suppressUntil" defaultValue={job.suppressUntil||''}/><Field label="有效窗口开始（含时区日期时间）" name="activeFrom" defaultValue={job.activeFrom||''}/><Field label="有效窗口结束（含时区日期时间）" name="activeUntil" defaultValue={job.activeUntil||''}/>
      {job.sourceFile&&<div className="hint"><p>{job.importNote}</p><p>来源：{job.sourceFile} · 原状态：{labels[job.sourceStatus]||job.sourceStatus}</p><pre>{JSON.stringify(job.sourceDefinition,null,2)}</pre></div>}
      {job.acknowledgedValues?.length>0&&<div className="hint">已处理记录<pre>{JSON.stringify(job.acknowledgedValues,null,2)}</pre></div>}
    </details></Form></Dialog>;
}
function Acknowledge({job,close}) {
  const {refresh}=useWorkbench();
  return <Dialog title="记录本次已处理" onClose={close}><p>{job.title}</p><Form onSave={async d=>{await api('jobs/acknowledge',{id:job.id,value:d.get('value')||undefined,until:d.get('until')?new Date(`${d.get('until')}:00+08:00`).toISOString():undefined,note:d.get('note')});await refresh();close();}}><Field label="已处理的具体对象（例如兑换码）" name="value"/><Field label="或者：本期完成，静默到下期（北京时间）" name="until" type="datetime-local"/><Field label="备注"><textarea name="note" defaultValue="用户确认已处理" rows={2}/></Field><p className="hint">长期监控会继续保留，本次处理不会取消以后每一期。</p></Form></Dialog>;
}
export function RunList() {
  const {state}=useWorkbench();
  return <div className="run-list">{state.runs.length?state.runs.slice(-50).reverse().map(run=><article className="run-row" key={run.id}><Badge value={run.status}/><div><strong>{state.jobs.find(j=>j.id===run.jobId)?.title||(run.background?'自然唤醒':'对话')}</strong><small>{fmt(run.createdAt)}{run.action==='silent'?' · 静默完成':''}</small>{(run.error||run.note)&&<p>{run.error||run.note}</p>}<RunProgress run={run} expanded={run.status==='running'}/></div></article>):<Empty title="还没有执行记录">后台执行不会自动向你发送通知。</Empty>}</div>;
}
export default function Jobs() {
  const {state,refresh,toast}=useWorkbench();const [filter,setFilter]=useState(''),[editing,setEditing]=useState(null),[ack,setAck]=useState(null),[importing,setImporting]=useState(false),[tab,setTab]=useState('jobs');
  const [skill,setSkill]=useState(null);
  const jobs=state.jobs.filter(j=>!filter||j.status===filter);
  return <><div className="page-toolbar"><p>交代一次，持续跟进。检查可以静默，提醒有据可查。</p><div className="actions"><Button onClick={()=>setImporting(true)}><Download size={16}/>导入定义</Button><Button className="primary" onClick={()=>setEditing({})}><Plus size={17}/>新建事项</Button></div></div>
    <div className="filter-bar"><div className="segmented"><button className={tab==='jobs'?'selected':''} onClick={()=>setTab('jobs')}>托管事项</button><button className={tab==='runs'?'selected':''} onClick={()=>setTab('runs')}>执行记录</button></div>{tab==='jobs'&&<select aria-label="筛选状态" value={filter} onChange={e=>setFilter(e.target.value)}><option value="">全部状态</option>{['active','draft','paused','blocked','done'].map(k=><option key={k} value={k}>{labels[k]}</option>)}</select>}</div>
    {tab==='runs'?<section className="panel"><RunList/></section>:jobs.length?<div className="cards">{jobs.map(job=><article className="job-card" key={job.id}><div className="section-heading"><Badge value={job.status}/><small>{labels[job.kind]}</small></div><h3>{job.title}</h3><p className="line-clamp">{job.instructions||job.notificationText||'等待进一步安排'}</p><div className="job-time"><Clock3 size={15}/><span>{job.nextRunAt?`下次 ${fmt(job.nextRunAt)}`:'手动或事件触发'}{job.suppressUntil?` · 静默至 ${fmt(job.suppressUntil)}`:''}</span></div>{job.lastError&&<div className="alert error">{job.lastError}</div>}<div className="card-actions"><Button onClick={()=>setEditing(job)}><Pencil size={14}/>编辑</Button>{job.status==='active'&&<><Button onClick={async()=>{await api('jobs/run',{id:job.id});await refresh();toast(job.kind==='reminder'?'已加入提醒箱':'已加入后台队列');}}><Play size={14}/>{job.kind==='reminder'?'现在提醒':'现在检查'}</Button><Button className="icon-button" title="暂停" aria-label="暂停" onClick={async()=>{await api('jobs/save',{...job,status:'paused'});await refresh();}}><Pause size={15}/></Button><Button className="icon-button" title="本次已处理" aria-label="本次已处理" onClick={()=>setAck(job)}><CheckCheck size={16}/></Button></>}</div></article>)}</div>:<Empty title="把一件事交给 Agent">创建周期检查、到点提醒，或导入 personal-hub 中的定义。</Empty>}
    <section className="panel learned-skills-panel"><div className="section-heading"><h2>任务技能 · 从执行中学习</h2><small>本机保存 · 版本可追溯</small></div><p className="muted">成功核验后沉淀为技能；下次优先复用。草稿、任务要求变化或执行异常时需要重新核对。</p>{state.learnedSkills?.length?<div className="learned-skills-list">{state.learnedSkills.map(s=><div className="learned-skill-row" key={s.jobId}><div><strong>{s.title}</strong><small>{({ready:'可复用',draft:'待成功核验',stale:'任务要求已变化',needs_review:'需要重新核对'})[s.status]} · 最新版本 v{s.version}{s.candidateVersion?` · 草稿 v${s.candidateVersion}`:''}</small></div><Button onClick={async()=>setSkill(await tool('cb_skills',{action:'read',jobId:s.jobId}))}>查看技能</Button></div>)}</div>:<p className="hint">还没有沉淀的技能。下一次循环任务会先读取经验，在成功核验后自动保存可复用流程。</p>}</section>
    {skill&&<Dialog title={`任务技能 · ${skill.title}`} onClose={()=>setSkill(null)} wide><Field label="版本"><select value={skill.selectedVersion} onChange={async e=>{try{setSkill(await tool('cb_skills',{action:'read',jobId:skill.jobId,version:Number(e.target.value)}));}catch(error){toast(error.message,true);}}}>{skill.versions.map(v=><option key={v.version} value={v.version}>v{v.version} · {v.status==='ready'?'曾通过执行核验':'草稿'} · {fmt(v.createdAt)}</option>)}</select></Field><p className="hint">来源是 Agent 的执行观察，不等于人工确认。每次运行仍需核对当前任务授权和页面状态。</p><pre>{skill.text}</pre><small>当前技能路径：{skill.path}</small></Dialog>}
    {editing&&<JobEditor job={editing} close={()=>setEditing(null)}/>} {ack&&<Acknowledge job={ack} close={()=>setAck(null)}/>}
    {importing&&<Dialog title="导入 personal-hub" onClose={()=>setImporting(false)}><Form submit="导入定义" onSave={async d=>{const result=await api('import',{path:d.get('path')});await refresh();toast(`新增 ${result.filter(r=>!r.skipped).length} 条，已有 ${result.filter(r=>r.skipped).length} 条保留`);setImporting(false);}}><Field label="本机仓库目录" name="path" defaultValue="D:\personal-hub" required/><p className="hint">源任务先以待接管状态导入，暂停、阻塞及完成状态保留。不会改动原仓库，重复导入不会覆盖你在这里的修改。</p></Form></Dialog>}
  </>;
}
