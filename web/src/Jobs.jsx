import React, { useRef, useState } from 'react';
import RunProgress from './RunProgress';
import WorkDetail, { Decision } from './WorkDetail';
import { MagpieModelField } from './MagpieSettings';
import { canHandleToday } from './HandledToday';
import JobActions from './JobActions';
import { Plus, Download, Clock3 } from 'lucide-react';
import { useWorkbench, api, tool, Button, Badge, Dialog, Form, Field, Empty, labels, fmt, localDate } from './shared';
import { presets, weekdays, shiftLocalDate, monthEndLocalDate, readScheduleFields, buildSchedule, describeSchedule } from './jobSchedule';

function initialScheduleFields(job) {
  const schedule = job.schedule || { type: 'manual' };
  const today = localDate();
  const [date, time] = schedule.type === 'once'
    ? [localDate(schedule.at), new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(schedule.at))]
    : [schedule.startDate || (schedule.type === 'recurring' && job.createdAt ? localDate(job.createdAt, job.timezone || undefined) : today), schedule.time || '09:00'];
  return readScheduleFields(schedule, date, time, today);
}

function ScheduleFields({ fields, setFields, onPresetChange }) {
  const [offset, setOffset] = useState('');
  const offsetDays = Number(offset);
  const canApplyOffset = offset !== '' && Number.isSafeInteger(offsetDays) && offsetDays >= 0;
  const { preset, startDate, time, hours, days, weeks, selectedDays, monthDays, workdayPosition, yearMonth, yearDay, rrule } = fields;
  const change = (key, value) => setFields(previous => ({ ...previous, [key]: value }));
  const input = key => event => change(key, event.target.value);
  const shift = days => change('startDate', shiftLocalDate(localDate(), days));
  const toggleDay = day => change('selectedDays', selectedDays.includes(day) ? selectedDays.filter(value => value !== day) : [...selectedDays, day]);
  return <>
    <Field label="什么时候检查或提醒"><select value={preset} onChange={event => onPresetChange(event.target.value)}>
      {Object.entries(presets).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></Field>
    {preset !== 'manual' && <div className="field-pair">
      <Field label={preset === 'once' ? '日期' : '周期起点'} type="date" value={startDate} onChange={input('startDate')} required/>
      {preset !== 'hourly' && <Field label={preset === 'once' ? '时间（北京时间 +08:00）' : '时间（下方时区）'} type="time" value={time} onChange={input('time')} required/>}
    </div>}
    {preset === 'once' && <>
      <div className="actions" role="group" aria-label="快捷日期">
        {[[0, '今天'], [1, '明天'], [3, '3天后'], [5, '5天后'], [7, '7天后']].map(([days, label]) => <Button key={days} onClick={() => shift(days)}>{label}</Button>)}
        <Button onClick={() => change('startDate', monthEndLocalDate(localDate()))}>本月末</Button>
      </div>
      <div className="actions inline-offset">
        <input type="number" step="any" aria-label="N 天后" placeholder="N 天后" value={offset} onChange={event => setOffset(event.target.value)}/>
        <Button disabled={!canApplyOffset} onClick={() => shift(offsetDays)}>应用</Button>
      </div>
    </>}
    {preset === 'hourly' && <p className="muted">例如 10:00、11:00。电脑关机期间不运行。</p>}
    {preset === 'hours' && <Field label="间隔小时数" type="number" min="1" max="10000" value={hours} onChange={input('hours')} required/>}
    {preset === 'interval' && <Field label="间隔天数" type="number" min="1" max="10000" value={days} onChange={input('days')} required/>}
    {preset === 'weekly' && <>
      <div className="actions" role="group" aria-label="选择星期">
        {Object.entries(weekdays).map(([day, label]) => <Button key={day} aria-pressed={selectedDays.includes(day)} className={selectedDays.includes(day) ? 'primary' : 'secondary'} onClick={() => toggleDay(day)}>{label}</Button>)}
      </div>
      <Field label="间隔周数" type="number" min="1" max="10000" value={weeks} onChange={input('weeks')} required/>
    </>}
    {preset === 'monthly-days' && <>
      <Field label="月内日期" value={monthDays} onChange={input('monthDays')} placeholder="例如 15、1,15 或 -3" hint="用逗号分隔多个日期。负数从月末倒数。" required/>
      <div className="actions">
        <Button onClick={() => change('monthDays', '15')}>每月15号</Button>
        <Button onClick={() => change('monthDays', '-3')}>月末倒数第3天</Button>
      </div>
    </>}
    {preset === 'monthly-workday' && <Field label="工作日位置"><select value={workdayPosition} onChange={input('workdayPosition')}>
      <option value="1">每月第 1 个工作日</option><option value="-1">每月最后 1 个工作日</option>
    </select></Field>}
    {preset === 'yearly' && <div className="field-pair">
      <Field label="月"><select value={yearMonth} onChange={input('yearMonth')}>
        {Array.from({ length: 12 }, (_, index) => <option key={index + 1}>{index + 1}</option>)}
      </select></Field>
      <Field label="日"><select value={yearDay} onChange={input('yearDay')}>
        {Array.from({ length: 31 }, (_, index) => <option key={index + 1}>{index + 1}</option>)}
      </select></Field>
    </div>}
    {preset === 'custom' && <Field label="RRULE" hint="例如 FREQ=DAILY;COUNT=5 或 FREQ=MONTHLY;BYDAY=1FR。">
      <textarea value={rrule} onChange={input('rrule')} rows={2} required/>
    </Field>}
    <p className="hint" aria-live="polite">{describeSchedule(fields)}</p>
  </>;
}

export function JobEditor({ job, close }) {
  const { state, refresh, toast }=useWorkbench();
  const [executor,setExecutor]=useState(job.executor||'codex'),[magpieModel,setMagpieModel]=useState(job.magpieModel||''),[models,setModels]=useState(state.magpie?.models||[]);
  const [initialFields] = useState(() => initialScheduleFields(job));
  const [fields, setFields] = useState(initialFields);
  const [kind, setKind] = useState(job.kind || 'watch');
  const [status, setStatus] = useState(job.status || (kind === 'reminder' ? 'active' : 'draft'));
  const statusEdited = useRef(false);
  const [instructions, setInstructions] = useState(job.instructions || '');
  const [notificationText, setNotificationText] = useState(job.notificationText ?? '');
  const [gap,setGap]=useState(job.minimumGapMinutes??1440);
  const [cadence,setCadence]=useState(job.notificationCadence || (Number(job.minimumGapMinutes ?? 1440) === 1440 ? 'daily' : 'interval'));
  const reminder = kind === 'reminder';
  const changeKind = value => {
    setKind(value);
    if (!job.id && !statusEdited.current) setStatus(value === 'reminder' ? 'active' : 'draft');
  };
  const changePreset = preset => {
    setFields(previous => ({ ...previous, preset }));
    if (!job.id && !reminder && ['hourly', 'hours'].includes(preset) && Number(gap) === 1440) {
      setGap(60);
      setCadence('interval');
    }
  };
  return <Dialog title={job.id?'编辑托管事项':'新建托管事项'} onClose={close} wide><Form onSave={async d=>{
    const schedule = fields === initialFields && job.schedule ? job.schedule : buildSchedule(fields);
    const minimumGapMinutes = reminder && (gap === '' || !Number.isFinite(Number(gap)) || Number(gap) < 0) ? job.minimumGapMinutes ?? 1440 : Number(gap);
    await api('jobs/save',{...job,executor,magpieModel,title:d.get('title'),kind,status,instructions,notificationText,contexts:d.get('contexts'),taskId:d.get('taskId'),todoVisibility:d.get('todoVisibility'),schedule,timezone:d.get('timezone'),notificationCadence:cadence,minimumGapMinutes,activeFrom:d.get('activeFrom'),activeUntil:d.get('activeUntil'),suppressUntil:d.get('suppressUntil')});
    await refresh(); toast('托管事项已保存'); close();
  }}>
    <Field label="事项名称" name="title" defaultValue={job.title||''} required maxLength={300}/>
    <div className="field-pair">
      <Field label="工作方式"><select value={kind} onChange={event => changeKind(event.target.value)}>{['reminder','watch','operation','opportunity'].map(k=><option key={k} value={k}>{labels[k]}</option>)}</select></Field>
      <Field label="状态"><select value={status} onChange={event => { statusEdited.current = true; setStatus(event.target.value); }}>{['draft','active','paused','blocked','done'].map(k=><option key={k} value={k}>{labels[k]}</option>)}</select></Field>
    </div>
    {reminder
      ? <Field label="到点提醒内容" value={notificationText} onChange={event => setNotificationText(event.target.value)} placeholder="留空时发送事项名称"/>
      : <Field label="具体要求、来源与执行边界"><textarea value={instructions} onChange={event => setInstructions(event.target.value)} rows={5} maxLength={50000}/></Field>}
    {!reminder&&<div className="form-section"><h3>交给谁执行</h3><Field label="执行方式"><select value={executor} onChange={e=>setExecutor(e.target.value)}><option value="codex">Codex · 主 Agent</option><option value="auto">自动 · 技能可复用时优先 Magpie</option><option value="magpie">Magpie · 指定 API 模型</option></select></Field>
      {executor!=='codex'&&<><MagpieModelField model={magpieModel} onChange={setMagpieModel} models={models} allowDefault defaultModel={state.magpie?.model}/><Button onClick={async()=>{const r=await api('magpie',{action:'models'});setModels(r.models);await refresh();toast(`已拉取 ${r.models.length} 个模型`);}}>拉取 Magpie 模型</Button>{!state.magpie?.enabled&&<p className="hint">Magpie 尚未启用，请先到设置页选择默认模型并启用；当前执行仍使用 Codex。</p>}<p className="hint">Magpie 使用工作台工具；需要 Codex 独有 MCP 或本地系统操作时交回主 Agent。自动模式按技能状态分配，不额外消耗模型来决定分配。</p></>}
    </div>}
    <div className="form-section">
      <h3>运行时间</h3>
      <ScheduleFields fields={fields} setFields={setFields} onPresetChange={changePreset}/>
      {reminder ? <p className="muted">到点后直接写入提醒箱并推送浏览器通知，不调用 AI，不受夜间免打扰拦截。</p> : <>
        <Field label="主动提醒频率"><select value={cadence} onChange={e=>setCadence(e.target.value)}><option value="daily">每天最多一次（按事项时区）</option><option value="interval">按间隔控制</option></select></Field>
        {cadence==='interval'&&<Field label="最小间隔（分钟）"><input type="number" min="0" value={gap} onChange={e=>setGap(e.target.value)} required/></Field>}
      </>}
    </div>
    {reminder && <details className="advanced">
      <summary>备注说明（可选，不触发 AI）</summary>
      <Field label="备注说明"><textarea value={instructions} onChange={event => setInstructions(event.target.value)} rows={3} maxLength={50000}/></Field>
    </details>}
    <details className="advanced" open={!!job.sourceFile}><summary>上下文与高级设置</summary><Field label="什么情境下可以顺手提起"><textarea name="contexts" rows={2} defaultValue={job.contexts||''}/></Field><Field label="关联待办 ID" name="taskId" defaultValue={job.taskId||''}/><Field label="关联卡片在待办中的显示" hint="自动模式下，周期性后台作业和信息监控只在托管事项中显示；需要亲自处理的关联待办可以保留。"><select name="todoVisibility" defaultValue={job.todoVisibility||'auto'}><option value="auto">自动（常规循环作业隐藏）</option><option value="show">在待办中保留</option><option value="hide">只在托管事项中显示</option></select></Field><Field label="周期时区" name="timezone" defaultValue={job.timezone||'Asia/Shanghai'}/><Field label="静默至（含时区日期时间，可留空）" name="suppressUntil" defaultValue={job.suppressUntil||''}/><Field label="有效窗口开始（含时区日期时间）" name="activeFrom" defaultValue={job.activeFrom||''}/><Field label="有效窗口结束（含时区日期时间）" name="activeUntil" defaultValue={job.activeUntil||''}/>
      {job.sourceFile&&<div className="hint"><p>{job.importNote}</p><p>来源：{job.sourceFile} · 原状态：{labels[job.sourceStatus]||job.sourceStatus}</p><pre>{JSON.stringify(job.sourceDefinition,null,2)}</pre></div>}
      {job.acknowledgedValues?.length>0&&<div className="hint">已处理记录<pre>{JSON.stringify(job.acknowledgedValues,null,2)}</pre></div>}
    </details></Form></Dialog>;
}
export function Acknowledge({job,close}) {
  const {refresh}=useWorkbench();
  return <Dialog title="记录本次已处理" onClose={close}><p>{job.title}</p>
    <Form onSave={async d => {
      const value = d.get('value').trim();
      const until = d.get('until');
      const scope = canHandleToday(job) && !value && !until ? 'today' : undefined;
      await api('jobs/acknowledge', { id:job.id, scope, value:value || undefined,
        until:until ? new Date(`${until}:00+08:00`).toISOString() : undefined, note:d.get('note').trim() });
      await refresh(); close();
    }}>
      {canHandleToday(job) && <p className="hint">直接保存即可记录今天已做。明天按原计划提醒。</p>}
      <Field label="已处理的具体对象（例如兑换码）" name="value"/>
      <Field label="或自定静默截止时间（北京时间）" name="until" type="datetime-local"/>
      <Field label="备注"><textarea name="note" rows={2}/></Field>
    </Form></Dialog>;
}
export function RunList() {
  const {state}=useWorkbench();
  return <div className="run-list">{state.runs.length?state.runs.slice(-50).reverse().map(run=><article className="run-row" key={run.id}><Badge value={run.status}/><div><strong>{state.jobs.find(j=>j.id===run.jobId)?.title||(run.background?'自然唤醒':'对话')}</strong><small>{fmt(run.createdAt)}{run.status==='completed'&&run.action==='silent'?' · 静默完成':''}</small>{(run.error||run.note)&&<p>{run.error||run.note}</p>}<Decision value={run.notificationDecision}/><RunProgress run={run} expanded={run.status==='running'}/></div></article>):<Empty title="还没有执行记录">后台执行不会自动向你发送通知。</Empty>}</div>;
}
export default function Jobs() {
  const {state,refresh,toast,selectedJob,setSelectedJob,editJob}=useWorkbench();const [filter,setFilter]=useState(''),[importing,setImporting]=useState(false),[tab,setTab]=useState('jobs');
  const [query,setQuery]=useState(''),[kindFilter,setKindFilter]=useState('');
  const [skill,setSkill]=useState(null);
  const jobs=state.jobs.filter(j=>(!filter||j.status===filter)&&(!kindFilter||j.kind===kindFilter)&&[j.title,j.instructions,j.notificationText].join(' ').toLowerCase().includes(query.toLowerCase()));
  return <><div className="page-toolbar"><p>交代一次，持续跟进。检查可以静默，提醒有据可查。</p><div className="actions"><Button onClick={()=>setImporting(true)}><Download size={16}/>导入定义</Button><Button className="primary" onClick={()=>editJob({})}><Plus size={17}/>新建事项</Button></div></div>
    <div className="filter-bar"><div className="segmented"><button className={tab==='jobs'?'selected':''} onClick={()=>setTab('jobs')}>托管事项</button><button className={tab==='runs'?'selected':''} onClick={()=>setTab('runs')}>执行记录</button></div>{tab==='jobs'&&<><input aria-label="搜索托管事项" placeholder="搜索事项…" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="事项类型" value={kindFilter} onChange={e=>setKindFilter(e.target.value)}><option value="">全部类型</option>{['reminder','watch','operation','opportunity'].map(k=><option key={k} value={k}>{labels[k]}</option>)}</select><select aria-label="筛选状态" value={filter} onChange={e=>setFilter(e.target.value)}><option value="">全部状态</option>{['active','draft','paused','blocked','done'].map(k=><option key={k} value={k}>{labels[k]}</option>)}</select></>}</div>
    {tab==='runs'?<section className="panel"><RunList/></section>:jobs.length?<div className="cards">{jobs.map(job=><article className="job-card" key={job.id}><div className="section-heading"><Badge value={job.status}/><small>{labels[job.kind]}</small></div><h3>{job.title}</h3><p className="line-clamp">{job.instructions||job.notificationText||'等待进一步安排'}</p><div className="job-time"><Clock3 size={15}/><span>{job.nextRunAt?`下次 ${fmt(job.nextRunAt)}`:'手动或事件触发'}{job.verificationRetry?.at?` · 核验重试 ${fmt(job.verificationRetry.at)}`:''}{Date.parse(job.suppressUntil)>Date.now()?` · 静默至 ${fmt(job.suppressUntil)}`:''}</span></div>{job.lastError&&<div className="alert error">{job.lastError}</div>}{state.work?.[job.id]?.summary&&<p className="line-clamp">{state.work[job.id].summary}</p>}{state.work?.[job.id]?.needsUser&&<p className="hint">需要你处理：{state.work[job.id].waitingFor}</p>}{!!state.work?.[job.id]?.subscriptionErrors?.length&&<p className="alert error">订阅来源读取失败，详情中可查看具体原因</p>}<div className="actions"><Button onClick={()=>setSelectedJob(job.id)}>进展与关联</Button></div><JobActions job={job}/></article>)}</div>:<Empty title="把一件事交给 Agent">创建周期检查、到点提醒，或导入 personal-hub 中的定义。</Empty>}
    <section className="panel learned-skills-panel"><div className="section-heading"><h2>任务技能 · 从执行中学习</h2><small>本机保存 · 版本可追溯</small></div><p className="muted">成功核验后沉淀为技能；下次优先复用。草稿、任务要求变化或执行异常时需要重新核对。</p>{state.learnedSkills?.length?<div className="learned-skills-list">{state.learnedSkills.map(s=><div className="learned-skill-row" key={s.jobId}><div><strong>{s.title}</strong><small>{({ready:'可复用',draft:'待成功核验',stale:'任务要求已变化',needs_review:'需要重新核对'})[s.status]} · 最新版本 v{s.version}{s.candidateVersion?` · 草稿 v${s.candidateVersion}`:''}</small></div><Button onClick={async()=>setSkill(await tool('cb_skills',{action:'read',jobId:s.jobId}))}>查看技能</Button></div>)}</div>:<p className="hint">还没有沉淀的技能。下一次循环任务会先读取经验，在成功核验后自动保存可复用流程。</p>}</section>
    {skill&&<Dialog title={`任务技能 · ${skill.title}`} onClose={()=>setSkill(null)} wide><Field label="版本"><select value={skill.selectedVersion} onChange={async e=>{try{setSkill(await tool('cb_skills',{action:'read',jobId:skill.jobId,version:Number(e.target.value)}));}catch(error){toast(error.message,true);}}}>{skill.versions.map(v=><option key={v.version} value={v.version}>v{v.version} · {v.status==='ready'?'曾通过执行核验':'草稿'} · {fmt(v.createdAt)}</option>)}</select></Field><p className="hint">来源是 Agent 的执行观察，不等于人工确认。每次运行仍需核对当前任务授权和页面状态。</p><p className="hint">最近成功核验：{fmt(skill.lastSuccessAt)}{skill.lastFailure?` · ${skill.lastFailure}`:''}</p><pre>{skill.text}</pre><small>当前技能路径：{skill.path}</small></Dialog>}
    {selectedJob&&<WorkDetail jobId={selectedJob} close={()=>setSelectedJob(null)}/>}
    {importing&&<Dialog title="导入 personal-hub" onClose={()=>setImporting(false)}><Form submit="导入定义" onSave={async d=>{const result=await api('import',{path:d.get('path')});await refresh();toast(`新增 ${result.filter(r=>!r.skipped).length} 条，已有 ${result.filter(r=>r.skipped).length} 条保留`);setImporting(false);}}><Field label="本机仓库目录" name="path" defaultValue="D:\personal-hub" required/><p className="hint">源任务先以待接管状态导入，暂停、阻塞及完成状态保留。不会改动原仓库，重复导入不会覆盖你在这里的修改。</p></Form></Dialog>}
  </>;
}
