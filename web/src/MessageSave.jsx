import React, { useState } from 'react';
import { Button, Dialog } from './shared';
import CreateTask from './CreateTask';
import { JobEditor } from './Jobs';
import { ToolEditor } from './Toolbox';
import { NoteEditor } from './Records';

export default function MessageSave({ message }) {
  const [target,setTarget]=useState(null);
  const title=message.text.split('\n').find(s=>s.trim())?.slice(0,200)||'从对话保存';
  const close=()=>setTarget(null);
  return <>
    <Button className="text-button" onClick={()=>setTarget('choose')}>保存到…</Button>
    {target==='choose'&&<Dialog title="保存这条消息" onClose={close}><div className="actions">
      <Button onClick={()=>setTarget('task')}>待办</Button><Button onClick={()=>setTarget('job')}>托管事项</Button>
      <Button onClick={()=>setTarget('tool')}>工具箱</Button><Button onClick={()=>setTarget('note')}>笔记</Button>
    </div></Dialog>}
    {target==='task'&&<CreateTask title={title} description={message.text} close={close}/>}
    {target==='job'&&<JobEditor job={{title,instructions:message.text,status:'draft'}} close={close}/>}
    {target==='tool'&&<ToolEditor item={{title,description:message.text}} close={close}/>}
    {target==='note'&&<NoteEditor note={{text:message.text}} close={close}/>}
  </>;
}
