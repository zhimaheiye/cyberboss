import React, { useEffect, useState } from 'react';
import { Plus, Search, Wrench } from 'lucide-react';
import { useWorkbench, tool, Button, Dialog, Form, Field, Empty, Badge } from './shared';
import { Connections } from './Search';
const availability = { unknown: '尚未确认', available: '可用', limited: '有限制', unavailable: '不可用' };
export default function Toolbox() {
  const { state, toast } = useWorkbench();
  const [query, setQuery] = useState(''), [archived, setArchived] = useState(false), [result, setResult] = useState(null), [error, setError] = useState('');
  const [editing, setEditing] = useState(null), [viewing, setViewing] = useState(null);
  async function load(offset = 0) {
    try { const next = await tool('cb_toolbox', { action: 'list', query, includeArchived: archived, offset }); setResult(old => ({ ...next, items: offset ? [...old.items, ...next.items] : next.items })); setError(''); } catch (e) { setError(e.message); }
  }
  useEffect(() => { let alive = true; tool('cb_toolbox', { action: 'list', query, includeArchived: archived }).then(r => { if (alive) { setResult(r); setError(''); } }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [state.toolboxRevision, archived]);
  return <><div className="page-toolbar"><p>存下工具的能力、用法和限制，需要时由你或 Agent 找到它。</p><Button className="primary" onClick={() => setEditing({})}><Plus size={16}/>添加工具</Button></div>
    <form className="filter-bar" onSubmit={e => { e.preventDefault(); void load(); }}><div className="search-input"><Search size={16}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="名称、能力、场景、别名…" aria-label="搜索工具"/></div><button>查找</button><label className="check"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)}/>包含归档</label></form>
    {error && <p className="alert error">{error}</p>}<div className="cards">{result?.items.map(item => <article className="memory-card" key={item.id}><div className="section-heading"><Wrench size={22}/><Badge>{item.archived ? '已归档' : availability[item.availability]}</Badge></div><h3>{item.title}</h3><p className="line-clamp">{item.description}</p><small>{item.tags.join(' · ')}</small><Button onClick={async () => setViewing(await tool('cb_toolbox', { action: 'get', id: item.id }))}>查看与关联</Button></article>)}</div>
    {result && !result.items.length && <Empty title="先存下一个以后可能用得上的工具">可以是软件、网站、脚本、MCP 或一套方法，暂时没有对应任务也能保存。</Empty>}
    {result?.nextOffset != null && <Button onClick={() => load(result.nextOffset)}>更多工具</Button>}
    {viewing && <Dialog title={viewing.title} onClose={() => setViewing(null)} wide><Badge>{availability[viewing.availability]}</Badge><p className="source-text">{viewing.description}</p>
      {[['适用场景', viewing.whenToUse], ['限制与前提', viewing.constraints], ['入口 / 路径 / 调用方式', viewing.locator], ['别名', viewing.aliases.join('、')]].filter(([, value]) => value).map(([label, value]) => <div key={label}><h3>{label}</h3><p className="source-text">{value}</p></div>)}
      <Button onClick={async () => { setEditing(await tool('cb_toolbox', { action: 'get', id: viewing.id })); setViewing(null); }}>编辑工具</Button>
      <Connections sourceRef={`tool:${viewing.id}`} title={viewing.title} onChat={() => setViewing(null)}/></Dialog>}
    {editing && <Dialog title={editing.id ? '编辑工具' : '添加工具'} onClose={() => setEditing(null)} wide><Form onSave={async fields => {
      await tool('cb_toolbox', { action: 'save', tool: { ...editing, title: fields.get('title'), description: fields.get('description'), whenToUse: fields.get('whenToUse'), constraints: fields.get('constraints'), locator: fields.get('locator'), tags: fields.get('tags'), aliases: fields.get('aliases'), availability: fields.get('availability'), archived: fields.get('archived') === 'on' } });
      setEditing(null); await load(); toast('工具已保存');
    }}><Field label="工具名称" name="title" defaultValue={editing.title || ''} required maxLength={200}/><Field label="能做什么"><textarea name="description" defaultValue={editing.description || ''} rows={4} maxLength={20000}/></Field>
      <Field label="什么时候可能用得上"><textarea name="whenToUse" defaultValue={editing.whenToUse || ''} rows={3} maxLength={6000}/></Field><Field label="限制、费用或使用前提"><textarea name="constraints" defaultValue={editing.constraints || ''} rows={3} maxLength={6000}/></Field>
      <Field label="入口、路径或调用方式" name="locator" defaultValue={editing.locator || ''} maxLength={2000}/><div className="field-pair"><Field label="标签（逗号分隔）" name="tags" defaultValue={(editing.tags || []).join('，')}/><Field label="别名 / 其他说法" name="aliases" defaultValue={(editing.aliases || []).join('，')}/></div>
      <Field label="可用状态"><select name="availability" defaultValue={editing.availability || 'unknown'}>{Object.entries(availability).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field><label className="check"><input type="checkbox" name="archived" defaultChecked={editing.archived}/>归档此工具</label>
    </Form></Dialog>}
  </>;
}
