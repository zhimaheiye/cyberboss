import React, { useRef, useState } from 'react';
import { Plus, Search, Check, RotateCcw, ExternalLink, MessageSquare, CalendarDays, RefreshCw } from 'lucide-react';
import { useWorkbench, api, tool, titleOf, descriptionOf, localDate, Button, Dialog, Form, Field, Empty, openTaskBoard } from './shared';

function TaskEditor({ task, close }) {
  const { refreshTasks, toast } = useWorkbench();
  return <Dialog title="编辑待办" onClose={close}><Form onSave={async data => {
    const date = data.get('date'), time = data.get('time');
    if (date && !time && task.due?.time) throw new Error('保留日期但移除时间，请在完整看板中修改');
    await tool('opentodo_update_tasks', { updates:[{ id:task.id, title:data.get('title'), description:data.get('description') }] });
    if (date !== (task.due?.date || '') || time !== (task.due?.time || '')) {
      try { await tool('opentodo_schedule_tasks', { ids:[task.id], due:date ? { date, ...(time ? { time, tz:'Asia/Shanghai' } : {}) } : null }); }
      catch (error) { throw new Error(`标题和说明已保存，日期未更新：${error.message}`); }
    }
    await refreshTasks(); toast('待办已保存'); close();
  }}><Field label="标题" name="title" defaultValue={titleOf(task)} required maxLength={300}/><Field label="说明"><textarea name="description" rows={5} defaultValue={descriptionOf(task)}/></Field>
    <div className="field-pair"><Field label="日期" name="date" type="date" defaultValue={task.due?.date || ''}/><Field label="时间（北京时间）" name="time" type="time" defaultValue={task.due?.time || ''}/></div>
    {task.recurrence && <p className="muted">周期：{task.recurrence}</p>}<p className="muted">更多周期、项目和日历设置可以在完整看板里管理。</p></Form></Dialog>;
}
export default function Tasks() {
  const { tasks, taskError, taskLoading, includeCompleted, setIncludeCompleted, refreshTasks, ask, toast } = useWorkbench();
  const [query, setQuery] = useState(''), [editing,setEditing] = useState(null), [view,setView] = useState('board');
  const creation = useRef(null);
  const filtered = tasks.filter(t => `${titleOf(t)} ${descriptionOf(t)}`.toLowerCase().includes(query.toLowerCase()));
  const groups = [['现在与逾期', filtered.filter(t => !t.completed && t.due?.date && t.due.date <= localDate())], ['之后与待安排', filtered.filter(t => !t.completed && (!t.due?.date || t.due.date > localDate()))], ['已经完成',filtered.filter(t => t.completed)]];
  return <><div className="page-toolbar"><p>你和 Agent 共同管理同一份待办。</p><Button onClick={openTaskBoard}><ExternalLink size={16}/>完整看板与日历</Button></div>
    <Form className="quick-create" submit={<><Plus size={17}/>添加待办</>} onSave={async (data,form) => {
      const item = { title:data.get('title'), ...(data.get('date') ? { due:{ date:data.get('date') } } : {}) };
      const signature=JSON.stringify(item); if (creation.current?.signature !== signature) creation.current={ signature,id:crypto.randomUUID() };
      await tool('opentodo_create_tasks',{ items:[item],client_request_id:creation.current.id }); creation.current=null; form.reset(); await refreshTasks();
    }}><input name="title" aria-label="新待办标题" placeholder="添加一件想做的事…" required maxLength={300}/><input name="date" type="date" aria-label="新待办日期"/></Form>
    <div className="filter-bar"><div className="search-input"><Search size={17}/><input aria-label="搜索待办" placeholder="搜索待办…" value={query} onChange={e => setQuery(e.target.value)}/></div><label className="check"><input type="checkbox" checked={includeCompleted} onChange={e => setIncludeCompleted(e.target.checked)}/>包含已完成</label><div className="segmented"><button className={view==='board'?'selected':''} onClick={()=>setView('board')}>看板</button><button className={view==='list'?'selected':''} onClick={()=>setView('list')}>列表</button></div><Button onClick={refreshTasks} disabled={taskLoading} title="刷新待办"><RefreshCw size={16}/></Button></div>
    {taskError && <div className="alert error">{taskError}</div>}
    {taskLoading && !tasks.length ? <Empty title="正在读取待办…"/> : <div className={view === 'board' ? 'task-board' : 'task-list'}>{groups.filter((_,i)=>includeCompleted || i<2).map(([label,items]) => <section className="task-column" key={label}><h2>{label}<span>{items.length}</span></h2>{items.map(task => <article className={`task-card ${task.completed?'completed':''}`} key={task.id}><div className="task-card-heading"><Button className="task-check" title={task.completed?'重新打开':'完成本次'} aria-label={task.completed?'重新打开':'完成本次'} onClick={async()=>{
      await tool(task.completed?'opentodo_reopen_tasks':'opentodo_complete_tasks',{ids:[task.id],...(task.completed?{}:{timezone:'Asia/Shanghai'})}); await refreshTasks(); toast(task.recurrence?'本期已完成，周期继续保留':'待办状态已更新');
    }}>{task.completed?<RotateCcw size={16}/>:<Check size={16}/>}</Button><Button className="task-title" onClick={async()=>{const {task:detail}=await tool('opentodo_get_task',{id:task.id,timezone:'Asia/Shanghai'});setEditing(detail);}}>{titleOf(task)}</Button></div>
      {descriptionOf(task) && <p className="line-clamp">{descriptionOf(task)}</p>}<div className="task-card-footer"><small><CalendarDays size={13}/>{task.due?.date || '未安排日期'} {task.due?.time || ''}{task.recurrence?' · 循环':''}</small><Button className="icon-button" title="聊聊这件事" aria-label="聊聊这件事" onClick={()=>ask(`关于待办「${titleOf(task)}」（任务 ID：${task.id}）：`)}><MessageSquare size={15}/></Button></div>
    </article>)}{!items.length&&<div className="column-empty">暂时没有事项</div>}</section>)}</div>}
    {editing&&<TaskEditor task={editing} close={()=>setEditing(null)}/>}</>;
}
