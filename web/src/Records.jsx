import React, { useEffect, useState } from 'react';
import { Plus, Search, FileText } from 'lucide-react';
import { useWorkbench, tool, api, Button, Dialog, Form, Field, Empty } from './shared';
import TaskHistory from './TaskHistory';
import { LinkText } from './LocalLinks';

export function NoteEditor({ note, close, onSaved }) {
  const { toast } = useWorkbench();
  const [current,setCurrent]=useState(note),[mode,setMode]=useState(note.name?'read':'edit'),[removing,setRemoving]=useState(false);
  const [renaming,setRenaming]=useState(false);
  async function saved() { onSaved?.(); close(); }
  return <Dialog title={current.name || '新的笔记'} onClose={close} wide>
    {mode==='read' ? <><div className="source-text"><LinkText text={current.text}/></div><div className="actions">
      <Button onClick={()=>setMode('edit')}>编辑内容</Button><Button onClick={()=>setRenaming(true)}>重命名</Button><Button onClick={()=>setRemoving(true)}>移到回收站</Button>
    </div></> : <Form onSave={async d=>{
      const name=d.get('name').trim().replace(/\.md$/i,'')+'.md',text=d.get('text');
      await tool('cb_memory',{action:'write',name,text,...(current.name?{expectedText:current.text}:{})});
      toast('笔记已保存'); await saved();
    }}><Field label="笔记名称" name="name" defaultValue={current.name||''} readOnly={!!current.name} required maxLength={123}/>
      <Field label="内容"><textarea name="text" defaultValue={current.text||''} rows={16} maxLength={200000}/></Field>
    </Form>}
    {renaming&&<Dialog title="重命名笔记" onClose={()=>setRenaming(false)}><Form onSave={async d=>{
      const result=await api('notes/manage',{action:'rename',name:current.name,newName:d.get('name').trim().replace(/\.md$/i,'')+'.md',expectedText:current.text});
      setCurrent(result);setRenaming(false);onSaved?.();toast('名称已更新');
    }}><Field label="笔记名称" name="name" defaultValue={current.name.replace(/\.md$/i,'')} required maxLength={120}/></Form></Dialog>}
    {removing&&<Dialog title="移到回收站" onClose={()=>setRemoving(false)}><p>笔记会移入本机数据目录的 memory/.trash 文件夹。</p><Button onClick={async()=>{
      await api('notes/manage',{action:'trash',name:current.name,expectedText:current.text});toast('已移到笔记回收站');await saved();
    }}>确认移入</Button></Dialog>}
  </Dialog>;
}

export function Memory() {
  const {noteRevision}=useWorkbench();const [items,setItems]=useState([]),[query,setQuery]=useState(''),[editing,setEditing]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  async function load(q=query) { setLoading(true);setError('');try{setItems(await tool('cb_memory',{action:q?'search':'list',query:q}));}catch(e){setError(e.message);}finally{setLoading(false);} }
  useEffect(()=>{void load();},[noteRevision]);
  return <><div className="page-toolbar"><p>重要的事留在本机，随时查看和修正。</p><Button className="primary" onClick={()=>setEditing({})}><Plus size={16}/>写一份笔记</Button></div><form className="filter-bar" onSubmit={e=>{e.preventDefault();void load();}}><div className="search-input"><Search size={17}/><input aria-label="搜索笔记" placeholder="搜索文件名或内容…" value={query} onChange={e=>setQuery(e.target.value)}/></div><button className="secondary" disabled={loading}>查找</button></form>
    {error&&<div className="alert error">{error}</div>}{loading?<Empty title="正在读取笔记…"/>:items.length?<div className="cards">{items.map(item=><article className="memory-card" key={item.name}><FileText size={22}/><h3>{item.name}</h3><p className="line-clamp"><LinkText text={item.preview}/></p><Button onClick={async()=>setEditing(await tool('cb_memory',{action:'read',name:item.name}))}>阅读与编辑</Button></article>)}</div>:<Empty title="还没有匹配的笔记">也可以直接在对话中说“帮我记住”。</Empty>}
    {editing&&<NoteEditor note={editing} close={()=>setEditing(null)} onSaved={()=>load()}/>}
  </>;
}
export function Timeline() {
  const {refresh}=useWorkbench();const [adding,setAdding]=useState(false);
  return <><div className="page-toolbar"><p>任务的完成与更正、自述和设备观察，按时间保留。</p><Button className="primary" onClick={()=>setAdding(true)}><Plus size={16}/>记下一刻</Button></div><TaskHistory timeline/>
    {adding&&<Dialog title="记下一刻" onClose={()=>setAdding(false)}><Form onSave={async d=>{await tool('cb_observe',{action:'append',text:d.get('text'),source:d.get('source'),evidence:'user'});await refresh();setAdding(false);}}><Field label="发生了什么"><textarea name="text" rows={6} required/></Field><Field label="来源" name="source" defaultValue="用户手动记录" required/></Form></Dialog>}
  </>;
}
