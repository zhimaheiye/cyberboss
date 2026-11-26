import React, { useRef, useState } from 'react';
import { Plus, Search, Check, RotateCcw, ExternalLink, MessageSquare, CalendarDays, RefreshCw, History, Compass } from 'lucide-react';
import { useWorkbench, api, tool, titleOf, descriptionOf, localDate, Button, Badge, Dialog, Form, Field, Empty, openTaskBoard, fmt } from './shared';
import TaskHistory, { completionAuthor } from './TaskHistory';
import { Connections } from './Search';
import { LinkText } from './LocalLinks';
import TaskDateFields from './TaskDateFields';

export function TaskEditor({ task, close }) {
  const { refreshTasks, toast, openGuide } = useWorkbench();
  const [removing, setRemoving] = useState(false);
  return <Dialog title="编辑待办" onClose={close}><Form onSave={async data => {
    const date = data.get('date'), time = data.get('time');
    await api('tasks/edit', { id:task.id, expected:task, patch:{ title:data.get('title'), description:data.get('description'),
      due:date ? { date, ...(time ? { time, tz:'Asia/Shanghai' } : {}) } : null } });
    await refreshTasks(); toast('待办已保存'); close();
  }}><Field label="标题" name="title" defaultValue={titleOf(task)} required maxLength={300}/><Field label="任务说明 · 背景、目标与完成条件"><textarea name="description" rows={7} placeholder="想解决什么、已有资料、限制，以及做到什么程度算完成…" defaultValue={descriptionOf(task)}/></Field>
    <TaskDateFields initialDate={task.due?.date} initialTime={task.due?.time}/>
    {task.recurrence && <p className="muted">周期：{task.recurrence}</p>}</Form>
    <div className="actions">
      {!task.completed && <Button onClick={() => { close(); openGuide(task); }}><Compass size={16}/>卡住了，看看怎么办</Button>}
      <Button onClick={()=>setRemoving(true)}>移到回收站</Button>
    </div>
    {removing&&<Dialog title="移到回收站" onClose={()=>setRemoving(false)}><p>将「{titleOf(task)}」移到 OpenTodo 回收站，可在完整看板恢复。</p><Button onClick={async()=>{
      await api('tasks/trash',{id:task.id,expected:task});close();await refreshTasks();toast('已移到回收站');
    }}>确认移入</Button></Dialog>}
    <Connections sourceRef={`task:${task.id}`} title={titleOf(task)} onChat={close}/><h3>完成与更正记录</h3><TaskHistory taskId={task.id}/></Dialog>;
}
export default function Tasks() {
  const { tasks, hiddenTaskCount, taskError, taskLoading, includeCompleted, setIncludeCompleted, refreshTasks, refresh, go, ask, toast } = useWorkbench();
  const [query, setQuery] = useState(''), [editing,setEditing] = useState(null), [view,setView] = useState('board'), [createKey,setCreateKey]=useState(0);
  const [reviewAI, setReviewAI] = useState(false), [historyTask, setHistoryTask] = useState(null);
  const creation = useRef(null);
  const filtered = tasks.filter(t => `${titleOf(t)} ${descriptionOf(t)}`.toLowerCase().includes(query.toLowerCase())
    && (!reviewAI || t.completed && t.completionRecord?.actor === 'agent'));
  const groups = [['今天', filtered.filter(t => !t.completed && t.due?.date === localDate())],
    ['已逾期', filtered.filter(t => !t.completed && t.due?.date && t.due.date < localDate())],
    ['之后与待安排', filtered.filter(t => !t.completed && (!t.due?.date || t.due.date > localDate()))],
    ...(includeCompleted ? [['已经完成',filtered.filter(t => t.completed)]] : [])];
  return <><div className="page-toolbar"><p>你和 Agent 共同管理同一份待办。</p><Button onClick={openTaskBoard}><ExternalLink size={16}/>完整看板与日历</Button></div>
    <div className="task-view-note"><span>常规 Agent 循环作业留在「交给 Agent」，异常进入提醒。{hiddenTaskCount > 0 ? `已隐藏 ${hiddenTaskCount} 条关联卡片。` : ''}</span><Button onClick={()=>go('jobs')}>查看托管事项</Button></div>
    <Form key={createKey} className="quick-create" submit={<><Plus size={17}/>添加待办</>} onSave={async (data,form) => {
      const item = { title:data.get('title'), description:data.get('description')||'', ...(data.get('date') ? { due:{ date:data.get('date'),...(data.get('time')?{time:data.get('time'),tz:'Asia/Shanghai'}:{}) } } : {}) };
      const signature=JSON.stringify(item); if (creation.current?.signature !== signature) creation.current={ signature,id:crypto.randomUUID() };
      await tool('opentodo_create_tasks',{ items:[item],client_request_id:creation.current.id }); creation.current=null; setCreateKey(k=>k+1); await refreshTasks();
    }}><input name="title" aria-label="新待办标题" placeholder="添加一件想做的事…" required maxLength={300}/><details><summary>日期与说明</summary><TaskDateFields initialDate={localDate()}/><Field label="说明"><textarea name="description" rows={3} maxLength={20000}/></Field></details></Form>
    <div className="filter-bar"><div className="search-input"><Search size={17}/><input aria-label="搜索待办" placeholder="搜索待办…" value={query} onChange={e => setQuery(e.target.value)}/></div><label className="check"><input type="checkbox" checked={includeCompleted} onChange={e => {setIncludeCompleted(e.target.checked);if(!e.target.checked)setReviewAI(false);}}/>包含已完成</label><label className="check"><input type="checkbox" checked={reviewAI} onChange={e=>{setReviewAI(e.target.checked);if(e.target.checked)setIncludeCompleted(true);}}/>核查 AI 完成</label><div className="segmented"><button className={view==='board'?'selected':''} onClick={()=>setView('board')}>看板</button><button className={view==='list'?'selected':''} onClick={()=>setView('list')}>列表</button></div><Button onClick={refreshTasks} disabled={taskLoading} title="刷新待办"><RefreshCw size={16}/></Button></div>
    {taskError && <div className="alert error">{taskError}</div>}
    {taskLoading && !tasks.length ? <Empty title="正在读取待办…"/> : <div className={view === 'board' ? 'task-board' : 'task-list'}>{groups.map(([label,items]) => <section className="task-column" key={label}><h2>{label}<span>{items.length}</span></h2>{items.map(task => <article className={`task-card ${task.completed?'completed':''}`} key={task.id}><div className="task-card-heading"><Button className="task-check" title={task.completed?'重新打开':'完成本次'} aria-label={task.completed?'重新打开':'完成本次'} onClick={async()=>{
      await tool(task.completed?'opentodo_reopen_tasks':'opentodo_complete_tasks',{ids:[task.id],completion_evidence:task.completed?'用户在待办页重新打开':'用户在待办页确认本次完成',...(task.completed?{}:{timezone:'Asia/Shanghai'})}); await refreshTasks(); toast(task.recurrence&&!task.completed?'本期已完成，周期继续保留':'待办状态已更新');
    }}>{task.completed?<RotateCcw size={16}/>:<Check size={16}/>}</Button><Button className="task-title" onClick={async()=>{const {task:detail}=await tool('opentodo_get_task',{id:task.id,timezone:'Asia/Shanghai'});setEditing(detail);}}>{titleOf(task)}</Button></div>
      {descriptionOf(task) && <p className="line-clamp"><LinkText text={descriptionOf(task)}/></p>}
      {task.completed && <div className="task-completion"><Badge>{completionAuthor(task.completionRecord)}</Badge><small title={task.completed_at}>{fmt(task.completed_at)}</small>
        {task.completionRecord?.actor !== 'user' && <Button onClick={async()=>{await api('tasks/confirm',{taskId:task.id,eventId:task.completionRecord?.id||null,completedAt:task.completed_at});await refresh();await refreshTasks();toast('已记录你的确认');}}>我确认已完成</Button>}</div>}
      <div className="task-card-footer"><small><CalendarDays size={13}/>{task.due?.date || '未安排日期'} {task.due?.time || ''}{task.recurrence?' · 循环':''}</small><Button className="icon-button" title="完成与更正记录" aria-label="完成与更正记录" onClick={()=>setHistoryTask(task)}><History size={15}/></Button><Button className="icon-button" title="聊聊这件事" aria-label="聊聊这件事" onClick={()=>ask(`关于待办「${titleOf(task)}」（任务 ID：${task.id}）：`)}><MessageSquare size={15}/></Button></div>
    </article>)}{!items.length&&<div className="column-empty">暂时没有事项</div>}</section>)}</div>}
    {editing&&<TaskEditor task={editing} close={()=>setEditing(null)}/>}{historyTask&&<Dialog title={`完成与更正 · ${titleOf(historyTask)}`} onClose={()=>setHistoryTask(null)} wide><TaskHistory taskId={historyTask.id}/></Dialog>}</>;
}
