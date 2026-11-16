import React, { useEffect, useState } from 'react';
import { Plus, Search, FileText } from 'lucide-react';
import { useWorkbench, tool, Button, Dialog, Form, Field, Empty } from './shared';
import TaskHistory from './TaskHistory';

export function Memory() {
  const {toast}=useWorkbench();const [items,setItems]=useState([]),[query,setQuery]=useState(''),[editing,setEditing]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  async function load(q=query) { setLoading(true);setError('');try{setItems(await tool('cb_memory',{action:q?'search':'list',query:q}));}catch(e){setError(e.message);}finally{setLoading(false);} }
  useEffect(()=>{void load('');},[]);
  return <><div className="page-toolbar"><p>重要的事留在本机，随时查看和修正。</p><Button className="primary" onClick={()=>setEditing({})}><Plus size={16}/>写一份笔记</Button></div><form className="filter-bar" onSubmit={e=>{e.preventDefault();void load();}}><div className="search-input"><Search size={17}/><input aria-label="搜索笔记" placeholder="搜索文件名或内容…" value={query} onChange={e=>setQuery(e.target.value)}/></div><button className="secondary" disabled={loading}>查找</button></form>
    {error&&<div className="alert error">{error}</div>}{loading?<Empty title="正在读取笔记…"/>:items.length?<div className="cards">{items.map(item=><article className="memory-card" key={item.name}><FileText size={22}/><h3>{item.name}</h3><p className="line-clamp">{item.preview}</p><Button onClick={async()=>setEditing(await tool('cb_memory',{action:'read',name:item.name}))}>阅读与编辑</Button></article>)}</div>:<Empty title="还没有匹配的笔记">也可以直接在对话中说“帮我记住”。</Empty>}
    {editing&&<Dialog title={editing.name?'编辑笔记':'新的笔记'} onClose={()=>setEditing(null)} wide><Form onSave={async d=>{await tool('cb_memory',{action:'write',name:d.get('name'),text:d.get('text'),...(editing.name?{expectedText:editing.text}:{})});setEditing(null);await load();toast('笔记已保存到本机');}}><Field label="文件名" name="name" defaultValue={editing.name||'新的笔记.md'} readOnly={!!editing.name} required pattern=".+\.md"/><Field label="内容"><textarea name="text" rows={16} defaultValue={editing.text||''} maxLength={200000}/></Field></Form></Dialog>}
  </>;
}
export function Timeline() {
  const {refresh}=useWorkbench();const [adding,setAdding]=useState(false);
  return <><div className="page-toolbar"><p>任务的完成与更正、自述和设备观察，按时间保留。</p><Button className="primary" onClick={()=>setAdding(true)}><Plus size={16}/>记下一刻</Button></div><TaskHistory timeline/>
    {adding&&<Dialog title="记下一刻" onClose={()=>setAdding(false)}><Form onSave={async d=>{await tool('cb_observe',{action:'append',text:d.get('text'),source:d.get('source'),evidence:'user'});await refresh();setAdding(false);}}><Field label="发生了什么"><textarea name="text" rows={6} required/></Field><Field label="来源" name="source" defaultValue="用户手动记录" required/></Form></Dialog>}
  </>;
}
