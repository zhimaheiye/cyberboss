import React, { useEffect, useState } from 'react';
import { Plus, Search, FileText } from 'lucide-react';
import { useWorkbench, tool, Button, Badge, Dialog, Form, Field, Empty, fmt } from './shared';

export function Memory() {
  const {toast}=useWorkbench();const [items,setItems]=useState([]),[query,setQuery]=useState(''),[editing,setEditing]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  async function load(q=query) { setLoading(true);setError('');try{setItems(await tool('cb_memory',{action:q?'search':'list',query:q}));}catch(e){setError(e.message);}finally{setLoading(false);} }
  useEffect(()=>{void load('');},[]);
  return <><div className="page-toolbar"><p>重要的事留在本机，随时查看和修正。</p><Button className="primary" onClick={()=>setEditing({})}><Plus size={16}/>写一份记忆</Button></div><form className="filter-bar" onSubmit={e=>{e.preventDefault();void load();}}><div className="search-input"><Search size={17}/><input aria-label="搜索记忆" placeholder="搜索文件名或内容…" value={query} onChange={e=>setQuery(e.target.value)}/></div><button className="secondary" disabled={loading}>查找</button></form>
    {error&&<div className="alert error">{error}</div>}{loading?<Empty title="正在读取记忆…"/>:items.length?<div className="cards">{items.map(item=><article className="memory-card" key={item.name}><FileText size={22}/><h3>{item.name}</h3><p className="line-clamp">{item.preview}</p><Button onClick={async()=>setEditing(await tool('cb_memory',{action:'read',name:item.name}))}>阅读与编辑</Button></article>)}</div>:<Empty title="还没有匹配的记忆">也可以直接在对话中说“帮我记住”。</Empty>}
    {editing&&<Dialog title={editing.name?'编辑记忆':'新的记忆'} onClose={()=>setEditing(null)} wide><Form onSave={async d=>{await tool('cb_memory',{action:'write',name:d.get('name'),text:d.get('text'),...(editing.name?{expectedText:editing.text}:{})});setEditing(null);await load();toast('记忆已保存到本机');}}><Field label="文件名" name="name" defaultValue={editing.name||'新的记忆.md'} readOnly={!!editing.name} required pattern=".+\.md"/><Field label="内容"><textarea name="text" rows={16} defaultValue={editing.text||''} maxLength={200000}/></Field></Form></Dialog>}
  </>;
}
export function Timeline() {
  const {state,refresh}=useWorkbench();const [adding,setAdding]=useState(false);
  return <><div className="page-toolbar"><p>自述、设备观察和推断分别记录，不把猜测当事实。</p><Button className="primary" onClick={()=>setAdding(true)}><Plus size={16}/>记下一刻</Button></div><div className="timeline">{state.observations.length?state.observations.slice().reverse().map(o=><article className="timeline-entry" key={o.id}><div className="timeline-date">{fmt(o.observedAt)}</div><div className="panel"><Badge value={o.evidence}/><p>{o.text}</p><small>来源：{o.source}</small></div></article>):<Empty title="从一个片段开始">对话与设备观察中的重要片段，会注明来源留在这里。</Empty>}</div>
    {adding&&<Dialog title="记下一刻" onClose={()=>setAdding(false)}><Form onSave={async d=>{await tool('cb_observe',{action:'append',text:d.get('text'),source:d.get('source'),evidence:'user'});await refresh();setAdding(false);}}><Field label="发生了什么"><textarea name="text" rows={6} required/></Field><Field label="来源" name="source" defaultValue="用户手动记录" required/></Form></Dialog>}
  </>;
}
