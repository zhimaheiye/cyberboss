import React, { useEffect, useState } from 'react';
import { api, tool, useWorkbench, Button, Badge, Empty, fmt, labels } from './shared';

export const completionAuthor = event => !event ? '完成来源未记录' : event.actor === 'user' ? '你已确认完成'
  : event.basis === 'user_statement' ? 'Agent 代记你的确认' : 'AI 判定完成 · 可核查';
const actions = { created: '创建待办', completed: '判定完成', occurrence_completed: '判定本期完成',
  reopened: '重新打开', confirmed: '确认已完成', job_acknowledged: '记录本次已处理', job_status_changed: '更改托管状态',
  uncertain: '操作结果需核对', requested: '已发起操作，尚无结果记录', receipt: '已收到回执，详细记录未完成' };
export function TaskEvent({ event }) {
  const e = event;
  return <><div className="section-heading"><Badge>{e.actor === 'user' ? '你' : 'Agent'} · {actions[e.action] || e.action}</Badge><time title={e.createdAt}>{new Date(e.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</time></div>
    <p>{e.title || '任务操作'}{e.before?.due?.date ? ` · 本期 ${e.before.due.date}` : ''}</p>
    {e.completedAt && <small>完成时间：{new Date(e.completedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</small>}
    {e.evidence && <p className="preserve-lines">{e.evidence}</p>}
    {e.userQuote && <blockquote>引用你的话：{e.userQuote}<small>原消息：{new Date(e.userStatementAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · Agent 代记</small></blockquote>}
    {e.nextDue && <small>后续一期：{e.nextDue}</small>}
    {e.action === 'job_status_changed' && <p>{labels[e.previousStatus]} → {labels[e.status]}</p>}
    {e.results && <details><summary>操作回执</summary><pre>{JSON.stringify(e.results, null, 2)}</pre></details>}
    {e.runId && <small>执行记录：{e.runId}</small>}
  </>;
}
export default function TaskHistory({ taskId, timeline = false }) {
  const { state, refresh, refreshTasks, toast } = useWorkbench();
  const [page, setPage] = useState({ events: [], nextCursor: null }), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [review, setReview] = useState(null);
  const [showExecution, setShowExecution] = useState(false);
  async function load(before) {
    const result = await api(`task-history?${new URLSearchParams({ ...(taskId ? { taskId } : {}), ...(before ? { before } : {}) })}`);
    setPage(previous => ({ events: before ? [...previous.events, ...result.events] : result.events, nextCursor: result.nextCursor }));
  }
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    api(`task-history?${new URLSearchParams(taskId ? { taskId } : {})}`).then(result => { if (!cancelled) setPage(result); })
      .catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId, state.taskHistoryRevision]);
  async function inspect(event) {
    const { task } = await tool('opentodo_get_task', { id: event.occurrenceId || event.taskId, timezone: 'Asia/Shanghai' });
    setReview({ eventId: event.id, task });
  }
  async function decide(confirmed) {
    const task = review.task;
    if (confirmed) await api('tasks/confirm', { taskId: task.id, eventId: task.completionRecord?.id || null, completedAt: task.completed_at });
    else await tool('opentodo_reopen_tasks', { ids: [task.id], completion_evidence: '用户核查后改回未完成' });
    setReview(null); await refresh(); await refreshTasks(); await load();
    toast(confirmed ? '已记录你的确认，原来的 AI 判断保留' : '已重新打开，之前的完成记录保留');
  }
  const entries = [...page.events.map(e => ({ type: 'task', at: e.createdAt, id: e.id, data: e })),
    ...(timeline ? [...state.observations, ...(showExecution ? state.executionObservations || [] : [])]
      .map(o => ({ type: 'observation', at: o.observedAt, id: o.id, data: o })) : [])]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return <div className="task-history"><p className="hint">保留每次判断、确认和更正。旧记录及完整看板内的操作可能没有来源；具体任务历史可继续加载。</p>
    {timeline && <div className="filter-bar"><label className="check"><input type="checkbox" checked={showExecution} onChange={e => setShowExecution(e.target.checked)}/>显示 Agent 执行记录</label></div>}
    {error && <div className="alert error">{error}</div>}{loading && <p className="hint">正在读取记录…</p>}
    {!loading && !entries.length && <Empty title="还没有记录"/>}
    {entries.map(entry => <article className="panel task-history-entry" key={entry.id}>{entry.type === 'observation'
      ? <><div className="section-heading"><Badge value={entry.data.evidence}>{entry.data.kind === 'execution' ? 'Agent 执行记录' : null}</Badge><time>{fmt(entry.at)}</time></div><p>{entry.data.text}</p><small>来源：{entry.data.source}</small></>
      : <><TaskEvent event={entry.data}/>{['completed', 'occurrence_completed', 'confirmed'].includes(entry.data.action) && <Button onClick={() => inspect(entry.data)}>核查当前状态</Button>}
        {review?.eventId === entry.id && <div className="task-review"><p>{review.task.completed ? completionAuthor(review.task.completionRecord) : '此项目前未完成'}</p>
          {review.task.completed && <div className="actions"><Button onClick={() => decide(true)}>我确认已完成</Button><Button onClick={() => decide(false)}>改回未完成</Button></div>}
          <Button onClick={() => setReview(null)}>收起</Button></div>}</>}
    </article>)}
    {page.nextCursor && <Button onClick={() => load(page.nextCursor)}>加载更早的任务记录</Button>}
  </div>;
}
