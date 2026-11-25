import React from 'react';
import { CheckCheck } from 'lucide-react';
import { api, Button, fmt, localDate, useWorkbench } from './shared';

export function canHandleToday(job) {
  return job?.status === 'active' && (job.schedule?.type === 'recurring' || job.kind === 'watch');
}

export default function HandledToday({ jobId, messageDate }) {
  const { state, refresh, toast } = useWorkbench();
  const job = state.jobs.find(item => item.id === jobId);
  if (!canHandleToday(job) || (messageDate && localDate(messageDate) !== localDate())) return null;
  const handled = Date.parse(job.handledTodayUntil) > Date.now() && Date.parse(job.suppressUntil) >= Date.parse(job.handledTodayUntil);
  return <Button title={handled ? '恢复今天后续的提醒' : '今天不再提醒，明天按原计划继续'} onClick={async () => {
    const saved = handled ? await api('jobs/undo-today', { id: job.id, version: job.version })
      : await api('jobs/acknowledge', { id: job.id, scope: 'today' });
    toast(handled ? '已撤销今天的完成确认' : `已记为今天完成，静默至 ${fmt(saved.suppressUntil)}`);
    await refresh();
  }}><CheckCheck size={16}/>{handled ? '撤销今天已做' : '今天已做'}</Button>;
}
