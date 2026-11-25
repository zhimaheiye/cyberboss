import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, GitBranch, Plus, Pencil, RotateCcw, BookOpen, Check } from 'lucide-react';
import { api, useWorkbench, Button, Dialog, Form, Field, Empty } from './shared';
import CreateTask from './CreateTask';

const newScene = () => ({ id: crypto.randomUUID(), title: '新的场景', description: '', entry: 'start', nodes: [
  { id: 'start', type: 'question', text: '想从哪里开始？', detail: '', options: [{ label: '继续', next: 'result' }] },
  { id: 'result', type: 'result', text: '写下下一步', detail: '' },
] });

function BranchEditor({ scene, save, remove, close }) {
  const [draft, setDraft] = useState(() => structuredClone(scene)), [selected, setSelected] = useState(scene.entry), [deleting, setDeleting] = useState(false);
  const node = draft.nodes.find(n => n.id === selected);
  const patchScene = patch => setDraft(d => ({ ...d, ...patch }));
  const patchNode = patch => setDraft(d => ({ ...d, nodes: d.nodes.map(n => n.id === selected ? { ...n, ...patch } : n) }));
  const incoming = draft.nodes.some(n => n.options?.some(option => option.next === selected));
  function addNode(type) {
    const id = crypto.randomUUID();
    const next = draft.nodes.find(n => n.type === 'result')?.id || draft.entry;
    setDraft(d => ({ ...d, nodes: [...d.nodes, { id, type, text: type === 'question' ? '新的问题' : '新的下一步', detail: '',
      ...(type === 'question' ? { options: [{ label: '继续', next }] } : {}) }] }));
    setSelected(id);
  }
  return <Dialog title="编辑场景与分支" onClose={close} wide><Form submit="保存分支" onSave={() => save(draft)}>
    <Field label="场景名称"><input value={draft.title} maxLength={120} required onChange={e => patchScene({ title: e.target.value })}/></Field>
    <Field label="简短说明"><input value={draft.description || ''} maxLength={600} onChange={e => patchScene({ description: e.target.value })}/></Field>
    <Field label="从哪个节点开始"><select value={draft.entry} onChange={e => patchScene({ entry: e.target.value })}>{draft.nodes.map(n => <option key={n.id} value={n.id}>{n.text.slice(0, 60)}</option>)}</select></Field>
    <div className="decision-editor"><div className="decision-node-list"><h3>问题与结果</h3>{draft.nodes.map(n => <button type="button" key={n.id} className={n.id === selected ? 'selected' : ''} onClick={() => setSelected(n.id)}><small>{n.type === 'question' ? '问题' : '结果'}{n.id === draft.entry ? ' · 入口' : ''}</small>{n.text.slice(0, 60)}</button>)}
      <div className="actions"><Button disabled={draft.nodes.length >= 100} onClick={() => addNode('question')}><Plus size={14}/>问题</Button><Button disabled={draft.nodes.length >= 100} onClick={() => addNode('result')}><Plus size={14}/>结果</Button></div></div>
      {node && <div className="decision-node-editor"><Field label={node.type === 'question' ? '问题' : '结果 / 下一步'}><textarea value={node.text} rows={3} maxLength={6000} required onChange={e => patchNode({ text: e.target.value })}/></Field>
        <Field label="补充说明"><textarea value={node.detail || ''} rows={4} maxLength={12000} onChange={e => patchNode({ detail: e.target.value })}/></Field>
        {node.options?.map((option, index) => <div className="decision-option-editor" key={index}>
          <Field label={`选项 ${index + 1}`}><input value={option.label} maxLength={300} required onChange={e => patchNode({ options: node.options.map((o, i) => i === index ? { ...o, label: e.target.value } : o) })}/></Field>
          <Field label="选择后前往"><select value={option.next} onChange={e => patchNode({ options: node.options.map((o, i) => i === index ? { ...o, next: e.target.value } : o) })}>{draft.nodes.map(n => <option disabled={n.id === node.id} key={n.id} value={n.id}>{n.type === 'question' ? '问题' : '结果'}：{n.text.slice(0, 60)}</option>)}</select></Field>
          <Button disabled={node.options.length === 1} onClick={() => patchNode({ options: node.options.filter((_, i) => i !== index) })}>移除此选项</Button>
        </div>)}
        {node.type === 'question' && <Button disabled={node.options.length >= 12} onClick={() => patchNode({ options: [...node.options, { label: '新的选项', next: draft.nodes.find(n => n.id !== node.id)?.id || node.id }] })}><Plus size={14}/>添加选项</Button>}
        <div className="decision-node-delete"><Button disabled={node.id === draft.entry || incoming} onClick={() => { patchScene({ nodes: draft.nodes.filter(n => n.id !== selected) }); setSelected(draft.entry); }}>删除此节点</Button><small>入口或仍被选项引用的节点，需要先调整连接。</small></div>
      </div>}
    </div>
    <p className="hint">修改保存在本机。关闭编辑窗口会放弃尚未保存的修改。</p>
  </Form>{remove && <div className="decision-remove">{deleting ? <><p>删除此场景会保留其他场景和原始笔记。</p><Button onClick={remove}>确认删除场景</Button><Button onClick={() => setDeleting(false)}>取消</Button></> : <Button onClick={() => setDeleting(true)}>删除整个场景</Button>}</div>}</Dialog>;
}

export default function DecisionGuide({ active }) {
  const { ask, go, toast } = useWorkbench();
  const [data, setData] = useState(null), [error, setError] = useState(''), [tab, setTab] = useState('guide');
  const [session, setSession] = useState(null), [trail, setTrail] = useState([]), [editing, setEditing] = useState(null), [reference, setReference] = useState(null);
  const [addingTask, setAddingTask] = useState(false), [created, setCreated] = useState({});
  const heading = useRef(null);
  useEffect(() => {
    if (!active || data) return;
    let cancelled = false;
    api('decision-guide').then(result => { if (!cancelled) { setData(result); setError(''); } }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [active, data]);
  const node = session?.scene.nodes.find(n => n.id === (trail.at(-1)?.next || session.scene.entry));
  useEffect(() => { if (active) heading.current?.focus({ preventScroll: true }); }, [active, session?.id, node?.id]);
  const routeText = session ? trail.map(step => `${session.scene.nodes.find(n => n.id === step.nodeId)?.text} → ${step.label}`).join('\n') : '';
  const resultKey = session ? `${session.id}:${node?.id}` : '';
  const context = session && node ? `场景：${session.scene.title}\n${routeText}\n下一步：${node.text}${node.detail ? `\n${node.detail}` : ''}` : '';
  function start(scene) { setSession({ id: crypto.randomUUID(), scene: structuredClone(scene) }); setTrail([]); }
  async function saveScenes(scenarios) {
    const result = await api('decision-guide', { revision: data.revision, scenarios });
    setData(result); setEditing(null); setSession(null); setTrail([]); toast('分支已保存到本机');
  }
  return <section hidden={!active} className="decision-page"><div className="page-toolbar"><p>把常用选择提前整理好，需要时沿着分支走几步。</p><div className="actions"><Button onClick={() => setEditing(newScene())} disabled={!data || data.scenarios.length >= 30}><Plus size={16}/>新建场景</Button></div></div>
    <div className="segmented decision-tabs">{[['guide', '开始选择'], ['branches', '场景与分支'], ['references', '原始笔记']].map(([id, label]) => <button key={id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
    {error && <div className="alert error">{error}<Button onClick={async () => { setData(await api('decision-guide')); setError(''); }}>重新读取</Button></div>}
    {!data ? !error && <Empty title="正在读取场景…"/> : tab === 'references' ? <><p className="hint">从旧工具迁入的资料，仅保存在本机。原文供后续整理，不会自动执行其中的规则或脚本。</p><div className="cards">{data.references.map(item => <article className="memory-card" key={item.name}><BookOpen size={22}/><h3>{item.title}</h3><Button onClick={async () => setReference(await api(`decision-guide/reference?name=${encodeURIComponent(item.name)}`))}>阅读原文</Button></article>)}</div>{!data.references.length && <Empty title="还没有迁入的笔记"/>}</>
      : tab === 'branches' ? <div className="cards">{data.scenarios.map(scene => <article className="memory-card" key={scene.id}><GitBranch size={22}/><h3>{scene.title}</h3><p>{scene.description}</p><small>{scene.nodes.filter(n => n.type === 'question').length} 个问题 · {scene.nodes.filter(n => n.type === 'result').length} 个结果</small><Button onClick={() => setEditing(scene)}><Pencil size={15}/>编辑分支</Button></article>)}</div>
      : !session ? <div className="cards">{data.scenarios.map(scene => <button className="decision-scene panel" key={scene.id} onClick={() => start(scene)}><GitBranch size={25}/><h2>{scene.title}</h2><p>{scene.description}</p><span>开始 <ArrowRight size={16}/></span></button>)}</div>
      : node && <div className="decision-session"><div className="decision-session-nav"><Button onClick={() => setSession(null)}><ArrowLeft size={16}/>全部场景</Button><span>{session.scene.title}</span><Button onClick={() => setTrail([])}><RotateCcw size={15}/>重新开始</Button></div>
        <article className={`panel decision-step ${node.type === 'result' ? 'decision-result' : ''}`}><span className="eyebrow">{node.type === 'question' ? `第 ${trail.length + 1} 步` : '这次的下一步'}</span><h2 tabIndex={-1} ref={heading}>{node.text}</h2>{node.detail && <p className="preserve-lines">{node.detail}</p>}
          {node.type === 'question' ? <div className="decision-options">{node.options.map((option, index) => <button key={index} onClick={() => setTrail(previous => (previous.at(-1)?.next || session.scene.entry) === node.id ? [...previous, { nodeId: node.id, label: option.label, next: option.next }] : previous)}><span>{option.label}</span><ArrowRight size={18}/></button>)}</div>
            : <div className="actions"><Button className="primary" disabled={!!created[resultKey]} onClick={() => setAddingTask(true)}>{created[resultKey] ? <><Check size={16}/>已加入待办</> : <><Plus size={16}/>加入待办</>}</Button><Button onClick={() => ask(`${context}\n\n我想接着聊聊这一步。`)}>带到对话</Button><Button onClick={() => go('tasks')}>看看待办</Button></div>}
          {trail.length > 0 && <Button className="text-button" onClick={() => setTrail(previous => previous.slice(0, -1))}><ArrowLeft size={15}/>返回上一步</Button>}
        </article>{trail.length > 0 && <details className="decision-trail"><summary>这次的选择 · {trail.length} 步</summary><ol>{trail.map((step, i) => <li key={i}><span>{session.scene.nodes.find(n => n.id === step.nodeId)?.text}</span><strong>{step.label}</strong></li>)}</ol></details>}
      </div>}
    {editing && <BranchEditor scene={editing} close={() => setEditing(null)} save={scene => saveScenes(data.scenarios.some(s => s.id === scene.id) ? data.scenarios.map(s => s.id === scene.id ? scene : s) : [...data.scenarios, scene])}
      remove={data.scenarios.length > 1 && data.scenarios.some(s => s.id === editing.id) ? () => saveScenes(data.scenarios.filter(s => s.id !== editing.id)) : null}/>}
    {reference && <Dialog title={reference.name.replace(/\.(md|txt)$/, '')} onClose={() => setReference(null)} wide><div className="decision-reference">{reference.text}</div></Dialog>}
    {addingTask && node && <CreateTask title={node.text} description={context} close={() => setAddingTask(false)} onCreated={() => setCreated(previous => ({ ...previous, [resultKey]: true }))}/>}
  </section>;
}
