import React, { useEffect, useRef, useState } from 'react';
import { api, Button, Dialog, Form, Field, titleOf, descriptionOf, tool, localDate, useWorkbench } from './shared';
import CreateTask from './CreateTask';
import { NoteEditor } from './Records';

export function FiveMinutes() {
  const [end,setEnd] = useState(null), [now,setNow] = useState(Date.now);
  const remaining = end === null ? null : Math.max(0, Math.ceil((end-now)/1000));
  useEffect(()=>{
    if (!end || remaining===0) return;
    const timer=setInterval(()=>setNow(Date.now()),500);
    return ()=>clearInterval(timer);
  },[end,remaining===0]);
  return <div className="actions">{remaining===null
    ? <Button onClick={()=>{const start=Date.now();setNow(start);setEnd(start+300000);}}>先做 5 分钟</Button>
    : <><strong role="timer">{remaining===0?'五分钟到了':Math.floor(remaining/60)+':'+String(remaining%60).padStart(2,'0')}</strong>
      <Button onClick={()=>setEnd(null)}>{remaining===0?'收起计时':'结束计时'}</Button></>}</div>;
}

function DeferTasks({tasks,taskId,close}) {
  const {refreshTasks,toast}=useWorkbench();
  const [ids,setIds]=useState(taskId?[taskId]:[]);
  return <Dialog title="选择要改期的待办" onClose={close}><Form submit="确认改期" onSave={async fields=>{
    if(!ids.length || ids.length>50)throw new Error('请选择 1～50 项待办');
    await tool('opentodo_schedule_tasks',{ids,due:{date:fields.get('date')}});
    close();await refreshTasks();toast('已更新所选待办的日期');
  }}>
    {tasks.map(t=><label className="check" key={t.id}><input type="checkbox" checked={ids.includes(t.id)} onChange={e=>setIds(e.target.checked?[...ids,t.id]:ids.filter(id=>id!==t.id))}/>{titleOf(t)} · {t.due?.date||'无日期'}</label>)}
    <Field label="移到哪天" type="date" name="date" required defaultValue={localDate(Date.now()+86400000)}/>
  </Form></Dialog>;
}

export default function StartActions({task,subject,step,reason,resources,soon,startBreathing}) {
  const {state,go,refresh,refreshTasks,editJob,toast}=useWorkbench();
  const [dialog,setDialog]=useState(''),[provider,setProvider]=useState('codex'),[plan,setPlan]=useState('');
  const [time,setTime]=useState('5 分钟'),[energy,setEnergy]=useState('一般');
  const request=useRef(null);
  const close=()=>setDialog('');
  async function appendStep() {
    const {task:detail}=await tool('opentodo_get_task',{id:task.id,timezone:'Asia/Shanghai'});
    if(detail.completed)throw new Error('这项待办已完成');
    const line='下一步：'+step, description=descriptionOf(detail);
    if(description.split('\n').includes(line)){toast('这一步已经写入待办');return;}
    // Update just the description; preserve scheduling and other fields from the task.
    await api('tasks/edit',{id:task.id,expected:detail,patch:{title:titleOf(detail),description:[description,line].filter(Boolean).join('\n')}});
    await refreshTasks();toast('已写入待办说明');
  }
  async function arrange() {
    const detail=task?(await tool('opentodo_get_task',{id:task.id,timezone:'Asia/Shanghai'})).task:null;
    const context=JSON.stringify({事情:subject||'通用速查',说明:detail?descriptionOf(detail).slice(0,3000):'',
      卡点:reason.title,当前动作:step,可用时间:time,精力:energy,今天和逾期待办数:soon.length,
      待安排:soon.slice(0,12).map(t=>({标题:titleOf(t),日期:t.due.date})),
      资源:resources.slice(0,8).map(r=>({名称:r.title,摘要:r.snippet,引用:r.ref}))},null,2);
    if(provider==='magpie'){
      const result=await api('procrastination',{action:'plan',context});
      setPlan(result.text);return;
    }
    const text='帮我安排眼前这件事。请给一条能马上动手的动作、一项可交给 Agent 的准备工作，以及适合延后的安排（如有）。用下列实际资源，缺的资料直接指出。这一次只给建议，任何写入和执行等我选择。\n'+context;
    if(request.current?.text!==text)request.current={text,id:crypto.randomUUID()};
    await api('chat',{text,requestId:request.current.id});request.current=null;
    await refresh();go('chat');close();
  }
  const title=subject||step;
  return <><div className="actions">
    {task?<Button onClick={appendStep}>写回待办第一步</Button>:<Button onClick={()=>setDialog('task')}>加入待办</Button>}
    <Button onClick={()=>setDialog('plan')}>请 AI 帮我安排</Button>
  </div><details><summary>其他做法</summary><div className="actions">
    <Button onClick={()=>editJob({title:title.slice(0,300),kind:'operation',status:'draft',instructions:'请帮我准备：'+step+'\n事情：'+title})}>交给 Agent 准备</Button>
    <Button className="breathing-entry secondary" onClick={startBreathing}>缓一缓</Button>
    <Button onClick={()=>setDialog('note')}>写一份草稿</Button>
    {(soon.length>0||task)&&<Button onClick={()=>setDialog('defer')}>调整待办日期</Button>}
  </div></details>
  {dialog==='plan'&&<Dialog title="结合手边资源安排" onClose={close}><div className="field-pair">
    <Field label="可用时间"><select value={time} onChange={e=>setTime(e.target.value)}>{['5 分钟','10 分钟','半小时以上'].map(t=><option key={t}>{t}</option>)}</select></Field>
    <Field label="目前精力"><select value={energy} onChange={e=>setEnergy(e.target.value)}>{['很低','一般','还不错'].map(t=><option key={t}>{t}</option>)}</select></Field></div>
    <Field label="使用模型"><select value={provider} onChange={e=>setProvider(e.target.value)}><option value="codex">Codex · 在对话中查看</option>
      {state.magpie?.enabled&&<option value="magpie">Magpie · 在这里查看</option>}</select></Field>
    <Button className="primary" onClick={arrange}>发送这次安排请求</Button>{plan&&<p className="preserve-lines">{plan}</p>}
  </Dialog>}
  {dialog==='defer'&&<DeferTasks tasks={task&&!soon.some(t=>t.id===task.id)?[task,...soon]:soon} taskId={task?.id} close={close}/>}
  {dialog==='task'&&<CreateTask title={title} description={step} close={close}/>}
  {dialog==='note'&&<NoteEditor note={{text:title+'\n\n'+step}} close={close}/>}
  </>;
}
