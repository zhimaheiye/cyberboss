import React, { useEffect, useState } from 'react';
import { Search, Link2, Plus } from 'lucide-react';
import { useWorkbench, tool, Button, Dialog, Field, Form, Empty, Badge, fmt } from './shared';
import { LinkText } from './LocalLinks';
export const sourceNames = { task: '待办', tool: '工具', job: '托管事项', event: '时间线事件', chat: '对话与提醒', note: '笔记',
  'start-guide':'拖延速查',
  decision: '决策分支', reference: '参考笔记', run: '执行摘要', skill: '任务技能', 'task-event': '任务状态记录', answer: '答案句库', favorite: '答案收藏', breathing: '呼吸记录' };

export function SourceViewer({ sourceRef, close, onNavigate, standalone = false }) {
  const { openSource } = useWorkbench(), [doc, setDoc] = useState(null), [error, setError] = useState('');
  useEffect(() => { let alive = true; setDoc(null); setError(''); tool('cb_recall', { action: 'read', ref: sourceRef }).then(d => { if (alive) setDoc(d); }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [sourceRef]);
  return <Dialog title={doc?.title || '读取原记录'} onClose={close} wide>{!doc && !error && <p role="status">正在读取原文…</p>}{error && <p className="alert error">{error}</p>}{doc && <>
    <div className="section-heading"><Badge>{sourceNames[doc.source]}</Badge><small>{fmt(doc.date)}</small></div>
    <div className="source-text"><LinkText text={doc.text}/></div>{doc.nextOffset !== null && <Button onClick={async () => {
      const next = await tool('cb_recall', { action: 'read', ref: sourceRef, offset: doc.nextOffset });
      if (next.hash !== doc.hash) throw new Error('原文已更新，请关闭后重新打开');
      setDoc({ ...next, text: doc.text + next.text });
    }}>继续读取</Button>}
    {!standalone&&<div className="actions"><Button onClick={async () => { close(); onNavigate?.(); await openSource(doc); }}>打开这条记录</Button></div>}
    <Connections sourceRef={doc.ref} title={doc.title} onChat={() => { close(); onNavigate?.(); }}/>
  </>}</Dialog>;
}
export function SearchDialog({ close, choose, initialQuery = '', onNavigate, savedState, onRemember }) {
  const {openSource}=useWorkbench();
  const [query, setQuery] = useState(savedState?.query || initialQuery), [source, setSource] = useState(savedState?.source || ''), [archived, setArchived] = useState(savedState?.archived || false);
  const [result, setResult] = useState(savedState?.result || null), [viewing, setViewing] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [lastQuery, setLastQuery] = useState(savedState?.lastQuery || null);
  useEffect(()=>{onRemember?.({query,source,archived,result,lastQuery});},[query,source,archived,result,lastQuery,onRemember]);
  async function search(offset = 0) {
    setBusy(true); setError('');
    const args = offset ? lastQuery : { action: 'search', query, ...(source ? { sources: [source] } : {}), includeArchived: archived };
    try {
      const next = await tool('cb_recall', { ...args, offset });
      setResult(previous => ({ ...next, items: offset ? [...previous.items, ...next.items] : next.items })); setLastQuery(args);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <Dialog title={choose ? '查找要关联的内容' : '搜索整个工作台'} onClose={close} wide><form className="filter-bar" onSubmit={e => { e.preventDefault(); if (!busy) void search(); }}>
    <div className="search-input"><Search size={17}/><input autoFocus aria-label="检索内容" value={query} onChange={e => setQuery(e.target.value)} placeholder="描述你想解决的事，或输入关键词…" maxLength={2000} required/></div>
    <select aria-label="来源" value={source} onChange={e => setSource(e.target.value)}><option value="">所有来源</option>{Object.entries(sourceNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
    <button disabled={busy}>{busy ? '检索中…' : '搜索'}</button></form><label className="check"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)}/>包含归档 / 停用内容</label>
    {error && <p className="alert error">{error}</p>}{result && <><p className="hint">{result.mode === 'hybrid' ? '关键词 + 向量' : '关键词'} · {result.total} 条结果</p>
      {result.warnings.map((warning, i) => <p className="hint" key={i}>{warning}</p>)}<div className="search-results">{result.items.map((item, i) => <article className="panel" key={`${item.ref}:${i}`}>
        <div className="section-heading"><Badge>{sourceNames[item.source]}</Badge><small>{fmt(item.date)}</small></div><h3>{item.title}</h3><p className="source-excerpt">{item.snippet}</p>
        {item.matchedTerms.length > 0 && <small>匹配：{item.matchedTerms.join('、')}</small>}<div className="actions"><Button onClick={() => setViewing(item.ref)}>查看原文</Button>{choose ? <Button onClick={() => choose(item)}><Link2 size={15}/>关联这条</Button> : <Button onClick={async()=>{close();onNavigate?.();await openSource(item);}}>打开这条记录</Button>}</div>
      </article>)}</div>{!result.items.length && <Empty title="没有找到匹配内容">可以换一种描述，或使用工具的能力、用途和别名搜索。</Empty>}
      {result.nextOffset !== null && <Button disabled={busy} onClick={() => search(result.nextOffset)}>更多结果</Button>}</>}
    {!result && !busy && <p className="hint">搜索现有待办、工具、事件、对话、笔记及其他工作台内容。结果可继续读取原文。</p>}
    {viewing && <SourceViewer sourceRef={viewing} close={() => setViewing(null)} onNavigate={() => { close(); onNavigate?.(); }}/>}
  </Dialog>;
}

export function Connections({ sourceRef, title, onChat }) {
  const { state, ask, toast } = useWorkbench(), [data, setData] = useState(null), [error, setError] = useState('');
  const [searching, setSearching] = useState(false), [candidate, setCandidate] = useState(null), [viewing, setViewing] = useState(null);
  async function load() { const next = await tool('cb_toolbox', { action: 'related', ref: sourceRef }); setData(next); setError(''); }
  useEffect(() => { let alive = true; tool('cb_toolbox', { action: 'related', ref: sourceRef }).then(d => { if (alive) { setData(d); setError(''); } }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [sourceRef, state.toolboxRevision, state.taskRevision]);
  return <section className="connections"><div className="section-heading"><h3>相关工具与资料</h3><Button onClick={() => setSearching(true)}><Plus size={15}/>关联内容</Button></div>
    <Button onClick={() => { onChat?.(); ask(`请读取 ${sourceRef}「${title}」，结合它的具体需求，用 cb_recall 跨来源检索可用工具、相关事件、对话和笔记。阅读原文后说明联系和限制，用 cb_toolbox 保存有依据的关联建议；如果已有可推进的授权任务，请继续完成相应工作。`); }}>让 Agent 找有用的联系</Button>
    {error && <p className="alert error">{error}</p>}{data?.links.filter(l => l.status !== 'dismissed').map(link => {
      const forward = link.fromRef === sourceRef, ref = forward ? link.toRef : link.fromRef;
      return <article className="connection-card" key={link.id}><div className="section-heading"><strong>{forward ? link.toTitle : link.fromTitle}</strong><Badge>{link.stale ? '原内容已变化 / 待核对' : link.status === 'confirmed' ? '已确认关联' : 'AI 关联建议'}</Badge></div>
        <p className="preserve-lines">{link.reason}</p><small>{fmt(link.updatedAt)} · {link.proposedBy === 'agent' ? 'Agent 提出' : '你建立的关联'}</small>
        <div className="actions"><Button onClick={() => setViewing(ref)}>查看原文</Button>{link.status === 'suggested' && <Button disabled={link.stale} onClick={async () => { await tool('cb_toolbox', { action: 'review', id: link.id, version: link.version, status: 'confirmed' }); await load(); }}>确认关联</Button>}
          <Button onClick={async () => { await tool('cb_toolbox', { action: 'review', id: link.id, version: link.version, status: 'dismissed' }); await load(); }}>忽略关联</Button></div>
        <details className="connection-history"><summary>关联记录</summary>{link.history.map((entry, index) => <p key={index}><small>{fmt(entry.at)} · {entry.actor === 'agent' ? 'Agent' : '你'} · {{ suggested: '提出建议', confirmed: '确认关联', dismissed: '忽略关联' }[entry.status]}</small>{entry.reason && <span>{entry.reason}</span>}</p>)}</details></article>;
    })}
    {data && !data.links.some(l => l.status !== 'dismissed') && <p className="hint">还没有关联，可自行添加，也可以让 Agent 检索后补充。</p>}
    {data?.links.some(l => l.status === 'dismissed') && <details><summary>已忽略的关联</summary>{data.links.filter(l => l.status === 'dismissed').map(l => <p key={l.id}>{l.fromTitle} ↔ {l.toTitle}：{l.reason}</p>)}</details>}
    {searching && <SearchDialog initialQuery={title} close={() => setSearching(false)} onNavigate={onChat} choose={item => { setCandidate(item); setSearching(false); }}/>}
    {candidate && <Dialog title={`关联到「${candidate.title}」`} onClose={() => setCandidate(null)}><Form onSave={async fields => {
      const [from, to] = await Promise.all([tool('cb_recall', { action: 'read', ref: sourceRef }), tool('cb_recall', { action: 'read', ref: candidate.ref })]);
      const latest = await tool('cb_toolbox', { action: 'related', ref: sourceRef });
      const old = latest.links.find(l => l.fromRef === candidate.ref || l.toRef === candidate.ref);
      await tool('cb_toolbox', { action: 'link', fromRef: from.ref, toRef: to.ref, fromHash: from.hash, toHash: to.hash, reason: fields.get('reason'), ...(old ? { version: old.version } : {}) });
      setCandidate(null); await load(); toast('关联已保存');
    }}><Field label="有什么联系 / 怎么用"><textarea name="reason" rows={4} maxLength={6000} required/></Field></Form></Dialog>}
    {viewing && <SourceViewer sourceRef={viewing} close={() => setViewing(null)} onNavigate={onChat}/>}
  </section>;
}
