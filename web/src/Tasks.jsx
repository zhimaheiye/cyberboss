import React, { useRef, useState } from 'react';
import { Plus, Search, Check, RotateCcw, ExternalLink, MessageSquare, CalendarDays, RefreshCw, History } from 'lucide-react';
import { useWorkbench, api, tool, titleOf, descriptionOf, localDate, Button, Badge, Dialog, Form, Field, Empty, openTaskBoard, fmt } from './shared';
import TaskHistory, { completionAuthor } from './TaskHistory';
import { Connections } from './Search';
import { LinkText } from './LocalLinks';

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
  }}><Field label="标题" name="title" defaultValue={titleOf(task)} required maxLength={300}/><Field label="任务说明 · 背景、目标与完成条件"><textarea name="description" rows={7} placeholder="想解决什么、已有资料、限制，以及做到什么程度算完成…" defaultValue={descriptionOf(task)}/></Field>
    <div className="field-pair"><Field label="日期" name="date" type="date" defaultValue={task.due?.date || ''}/><Field label="时间（北京时间）" name="time" type="time" defaultValue={task.due?.time || ''}/></div>
    {task.recurrence && <p className="muted">周期：{task.recurrence}</p>}<p className="muted">更多周期、项目和日历设置可以在完整看板里管理。</p></Form><Connections sourceRef={`task:${task.id}`} title={titleOf(task)} onChat={close}/><h3>完成与更正记录</h3><TaskHistory taskId={task.id}/></Dialog>;
}
export default function Tasks() {
  const { tasks, hiddenTaskCount, taskError, taskLoading, includeCompleted, setIncludeCompleted, refreshTasks, refresh, go, ask, toast } = useWorkbench();
  const [query, setQuery] = useState(''), [editing,setEditing] = useState(null), [view,setView] = useState('board');
  const [reviewAI, setReviewAI] = useState(false), [historyTask, setHistoryTask] = useState(null);
  const creation = useRef(null);
  const filtered = tasks.filter(t => `${titleOf(t)} ${descriptionOf(t)}`.toLowerCase().includes(query.toLowerCase())
    && (!reviewAI || t.completed && t.completionRecord?.actor === 'agent'));
  const groups = [['现在与逾期', filtered.filter(t => !t.completed && t.due?.date && t.due.date <= localDate())], ['之后与待安排', filtered.filter(t => !t.completed && (!t.due?.date || t.due.date > localDate()))], ['已经完成',filtered.filter(t => t.completed)]];
  return <><div className="page-toolbar"><p>你和 Agent 共同管理同一份待办。</p><Button onClick={openTaskBoard}><ExternalLink size={16}/>完整看板与日历</Button></div>
    <div className="task-view-note"><span>常规 Agent 循环作业留在「交给 Agent」，异常进入提醒。{hiddenTaskCount > 0 ? `已隐藏 ${hiddenTaskCount} 条关联卡片。` : ''}</span><Button onClick={()=>go('jobs')}>查看托管事项</Button></div>
    <Form className="quick-create" submit={<><Plus size={17}/>添加待办</>} onSave={async (data,form) => {
      const item = { title:data.get('title'), ...(data.get('date') ? { due:{ date:data.get('date') } } : {}) };
      const signature=JSON.stringify(item); if (creation.current?.signature !== signature) creation.current={ signature,id:crypto.randomUUID() };
      await tool('opentodo_create_tasks',{ items:[item],client_request_id:creation.current.id }); creation.current=null; form.reset(); await refreshTasks();
    }}><input name="title" aria-label="新待办标题" placeholder="添加一件想做的事…" required maxLength={300}/><input name="date" type="date" aria-label="新待办日期"/></Form>
    <div className="filter-bar"><div className="search-input"><Search size={17}/><input aria-label="搜索待办" placeholder="搜索待办…" value={query} onChange={e => setQuery(e.target.value)}/></div><label className="check"><input type="checkbox" checked={includeCompleted} onChange={e => {setIncludeCompleted(e.target.checked);if(!e.target.checked)setReviewAI(false);}}/>包含已完成</label><label className="check"><input type="checkbox" checked={reviewAI} onChange={e=>{setReviewAI(e.target.checked);if(e.target.checked)setIncludeCompleted(true);}}/>核查 AI 完成</label><div className="segmented"><button className={view==='board'?'selected':''} onClick={()=>setView('board')}>看板</button><button className={view==='list'?'selected':''} onClick={()=>setView('list')}>列表</button></div><Button onClick={refreshTasks} disabled={taskLoading} title="刷新待办"><RefreshCw size={16}/></Button></div>
    {taskError && <div className="alert error">{taskError}</div>}
    {taskLoading && !tasks.length ? <Empty title="正在读取待办…"/> : <div className={view === 'board' ? 'task-board' : 'task-list'}>{groups.filter((_,i)=>includeCompleted || i<2).map(([label,items]) => <section className="task-column" key={label}><h2>{label}<span>{items.length}</span></h2>{items.map(task => <article className={`task-card ${task.completed?'completed':''}`} key={task.id}><div className="task-card-heading"><Button className="task-check" title={task.completed?'重新打开':'完成本次'} aria-label={task.completed?'重新打开':'完成本次'} onClick={async()=>{
      await tool(task.completed?'opentodo_reopen_tasks':'opentodo_complete_tasks',{ids:[task.id],completion_evidence:task.completed?'用户在待办页重新打开':'用户在待办页确认本次完成',...(task.completed?{}:{timezone:'Asia/Shanghai'})}); await refreshTasks(); toast(task.recurrence&&!task.completed?'本期已完成，周期继续保留':'待办状态已更新');
    }}>{task.completed?<RotateCcw size={16}/>:<Check size={16}/>}</Button><Button className="task-title" onClick={async()=>{const {task:detail}=await tool('opentodo_get_task',{id:task.id,timezone:'Asia/Shanghai'});setEditing(detail);}}>{titleOf(task)}</Button></div>
      {descriptionOf(task) && <p className="line-clamp"><LinkText text={descriptionOf(task)}/></p>}
      {task.completed && <div className="task-completion"><Badge>{completionAuthor(task.completionRecord)}</Badge><small title={task.completed_at}>{fmt(task.completed_at)}</small>
        {task.completionRecord?.actor !== 'user' && <Button onClick={async()=>{await api('tasks/confirm',{taskId:task.id,eventId:task.completionRecord?.id||null,completedAt:task.completed_at});await refresh();await refreshTasks();toast('已记录你的确认');}}>我确认已完成</Button>}</div>}
      <div className="task-card-footer"><small><CalendarDays size={13}/>{task.due?.date || '未安排日期'} {task.due?.time || ''}{task.recurrence?' · 循环':''}</small><Button className="icon-button" title="完成与更正记录" aria-label="完成与更正记录" onClick={()=>setHistoryTask(task)}><History size={15}/></Button><Button className="icon-button" title="聊聊这件事" aria-label="聊聊这件事" onClick={()=>ask(`关于待办「${titleOf(task)}」（任务 ID：${task.id}）：`)}><MessageSquare size={15}/></Button></div>
    </article>)}{!items.length&&<div className="column-empty">暂时没有事项</div>}</section>)}</div>}
    {editing&&<TaskEditor task={editing} close={()=>setEditing(null)}/>}{historyTask&&<Dialog title={`完成与更正 · ${titleOf(historyTask)}`} onClose={()=>setHistoryTask(null)} wide><TaskHistory taskId={historyTask.id}/></Dialog>}</>;
}
