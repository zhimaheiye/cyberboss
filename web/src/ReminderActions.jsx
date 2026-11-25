import React from 'react';
import { Button, api, useWorkbench } from './shared';
import HandledToday from './HandledToday';

export default function ReminderActions({ message, onNavigate }) {
  const { refresh, openJob } = useWorkbench();
  return <div className="actions">
    {message.unread && <Button onClick={async () => { await api('read', { id:message.id }); await refresh(); }}>知道了</Button>}
    {!message.jobException && !message.verificationException && message.jobId && <HandledToday jobId={message.jobId} messageDate={message.createdAt}/>}
    {message.jobId && <Button onClick={() => { openJob(message.jobId); onNavigate?.(); }}>查看事项</Button>}
  </div>;
}
