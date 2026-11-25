import React, { useRef } from 'react';
import { Dialog, Form, Field, tool, useWorkbench, localDate } from './shared';
import TaskDateFields from './TaskDateFields';

export default function CreateTask({ title = '', description = '', date = localDate(), close, onCreated }) {
  const { refreshTasks, toast } = useWorkbench(), request = useRef(null);
  return <Dialog title="加入待办" onClose={close}><Form submit="添加待办" onSave={async fields => {
    const date = fields.get('date'), time = fields.get('time');
    const item = { title:fields.get('title'), description:fields.get('description'),
      ...(date ? { due:{date, ...(time ? {time,tz:'Asia/Shanghai'} : {})} } : {}) };
    const signature = JSON.stringify(item);
    if (request.current?.signature !== signature) request.current = {signature,id:crypto.randomUUID()};
    await tool('opentodo_create_tasks',{items:[item],client_request_id:request.current.id});
    onCreated?.(); close(); toast('已加入待办'); await refreshTasks();
  }}>
    <Field label="待办标题" name="title" defaultValue={title.slice(0,300)} required maxLength={300}/>
    <Field label="说明"><textarea name="description" defaultValue={description} rows={5} maxLength={20000}/></Field>
    <TaskDateFields initialDate={date}/>
  </Form></Dialog>;
}
