import React, { useState } from 'react';
import { Button, Dialog, fmt, useWorkbench, api } from './shared';
import HandledToday from './HandledToday';
import { StopBackgroundRun } from './RunProgress';

export default function JobActions({ job, onNavigate }) {
  const { state, refresh, toast, ask, editJob, acknowledgeJob } = useWorkbench();
  const [ending, setEnding] = useState(false);
  const running = state.runs.findLast(r => r.jobId === job.id && r.status === 'running');
  const suppressed = Date.parse(job.suppressUntil) > Date.now();
  async function setStatus(status) {
    await api('jobs/save', { ...job, status });
    await refresh();
  }
  return <div className="card-actions">
    {running && <StopBackgroundRun run={running}/>}
    {job.status === 'active' ? <>
      <Button disabled={suppressed || !!running} title={suppressed ? `静默至 ${fmt(job.suppressUntil)}` : ''} onClick={async () => {
        await api('jobs/run', { id: job.id }); await refresh();
        toast(job.kind === 'reminder' ? '已加入提醒箱' : '已加入后台队列');
      }}>{suppressed ? '静默中' : job.kind === 'reminder' ? '现在提醒' : '现在检查'}</Button>
      <HandledToday jobId={job.id}/>
      <Button onClick={() => acknowledgeJob(job)}>其他处理</Button>
      <Button onClick={() => setStatus('paused')}>暂停</Button>
    </> : <Button onClick={() => setStatus('active')}>{job.status === 'draft' ? '启用' : '恢复启用'}</Button>}
    <Button onClick={() => editJob(job)}>编辑</Button>
    <Button onClick={() => {
      onNavigate?.();
      ask(`关于托管事项「${job.title}」（job:${job.id}）：\n${job.instructions || job.notificationText || ''}\n${job.lastError ? '最近执行问题：' + job.lastError + '\n' : ''}我想聊聊这件事。`);
    }}>聊聊这件事</Button>
    {job.status !== 'done' && <Button onClick={() => setEnding(true)}>结束事项</Button>}
    {ending && <Dialog title="结束这项安排" onClose={() => setEnding(false)}>
      <p>结束「{job.title}」的后续安排。历史记录保留，之后可以恢复启用。</p>
      <Button onClick={async () => { await setStatus('done'); setEnding(false); }}>确认结束</Button>
    </Dialog>}
  </div>;
}
