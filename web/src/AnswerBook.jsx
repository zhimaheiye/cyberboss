import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PageFlip } from '@gullabs/flipbook-core';
import { BookOpen, Bookmark, Copy, Download, Library, Plus, Search, Upload, Pencil, Trash2, RotateCcw } from 'lucide-react';
import { api, useWorkbench, Button, Dialog, Form, Field, Empty, fmt } from './shared';

const poolLabel = { general: '通用句库', personal: '我的句子', mixed: '混合句库' };

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return reduced;
}

// The flip engine owns only the nodes inside this empty host. Dispose its renderer and
// listeners on every unmount; React continues to own the surrounding controls.
function BookScene({ result, opening, onOpened }) {
  const host = useRef(null), done = useRef(onOpened);
  const reduced = useReducedMotion();
  done.current = onOpened;
  useEffect(() => {
    const root = document.createElement('div');
    root.className = 'answer-flip';
    if (result && opening && !reduced) root.classList.add('answer-initial-cover');
    host.current.append(root);
    function leaf(kind, heading, text, footer) {
      const page = document.createElement('div'); page.className = `answer-leaf ${kind}`;
      page.dataset.density = kind === 'answer-cover' ? 'hard' : 'soft';
      const face = document.createElement('div'); face.className = 'answer-face';
      for (const [tag, className, content] of [['span', 'answer-running-head', heading], ['p', 'answer-page-text', text], ['span', 'answer-folio', footer]]) {
        const node = document.createElement(tag); node.className = className; node.textContent = content; face.append(node);
      }
      page.append(face); root.append(page); return page;
    }
    const pages = [
      leaf('answer-cover', 'THE BOOK OF ANSWERS', '答案之书', '点击 · 翻开一页'),
      leaf('answer-question-page', '这一刻的问题', result?.question || '随手翻开的一页', '留给此刻'),
      leaf('answer-result-page', '答案之书', result?.text || '', result ? poolLabel[result.pool] : ''),
      leaf('answer-cover', 'THE BOOK OF ANSWERS', '答案之书', ''),
    ];
    let flip, frame, fallback;
    try {
      flip = new PageFlip(root, { width: 300, height: 410, sizing: 'responsive', minWidth: 130, maxWidth: 330,
        minHeight: 178, maxHeight: 451, hardCovers: true, usePortrait: false, autoSize: true,
        drawShadow: true, maxShadowOpacity: 0.18, flippingTime: 900,
        pointerInput: [], flipOnClick: 'never', foldCornerOnHover: false, allowTouchScroll: true, pageBackground: '#fbf7ec' });
      flip.on('changeState', event => {
        if (event.data.state === 'read' && result) done.current();
      });
      flip.loadFromHTML(pages);
      if (result) {
        if (reduced || !opening) { flip.turnToPage(1); done.current(); }
        else {
          frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => { root.classList.remove('answer-initial-cover'); flip.flipNext(); });
          });
          // A hidden window can defer RAF. Keep the reveal recoverable on return.
          fallback = setTimeout(() => { root.classList.remove('answer-initial-cover'); flip.turnToPage(1); done.current(); }, 1600);
        }
      }
    } catch {
      // Preserve the actual answer if the decorative renderer is unavailable.
      root.replaceChildren(...(result ? pages.slice(1, 3) : [pages[0]]));
      root.classList.remove('answer-initial-cover');
      root.classList.add('answer-static');
      if (result) done.current();
    }
    return () => { cancelAnimationFrame(frame); clearTimeout(fallback); flip?.destroy(); root.remove(); };
    // Each draw is a fresh book reveal; unrelated form edits must not restart it.
  }, [result?.id, reduced]);
  return <div className={`answer-book-scene ${result ? 'is-open' : 'is-closed'}`} ref={host} aria-hidden="true"/>;
}

function exportFile(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AnswerBook() {
  const { toast } = useWorkbench();
  const [data, setData] = useState(null), [error, setError] = useState('');
  const [tab, setTab] = useState('book'), [pool, setPool] = useState('mixed');
  const [question, setQuestion] = useState(''), [result, setResult] = useState(null), [phase, setPhase] = useState('idle');
  const [libraryPool, setLibraryPool] = useState('personal'), [query, setQuery] = useState(''), [page, setPage] = useState(0);
  const [editing, setEditing] = useState(null), [importing, setImporting] = useState(false), [removing, setRemoving] = useState(null);
  const [importText, setImportText] = useState(''), [importFormat, setImportFormat] = useState('text'), [importPool, setImportPool] = useState('personal');
  const drawing = useRef(false), mounted = useRef(true);
  const load = useCallback(async () => {
    const next = await api('answer-book');
    if (mounted.current) { setData(next); setError(''); }
    return next;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load().catch(e => setError(e.message));
    return () => { mounted.current = false; };
  }, [load]);
  useEffect(() => { setPage(0); }, [query, libraryPool]);
  async function change(input) { const response = await api('answer-book', input); await load(); return response; }
  async function draw() {
    if (drawing.current || phase === 'opening') return;
    drawing.current = true; setPhase('loading');
    const savedQuestion = question.trim();
    try {
      const answer = await api('answer-book', { action: 'draw', pool });
      if (mounted.current) { setResult({ ...answer, question: savedQuestion }); setPhase('opening'); }
    } catch (e) { if (mounted.current) setPhase('idle'); throw e; }
    finally { drawing.current = false; }
  }
  async function downloadLibrary() {
    const imported = await change({ action: 'download' });
    if (pool === 'personal' && !data.available.personal) setPool('mixed');
    toast(`通用句库已保存到本机，新增 ${imported.added} 句，跳过重复 ${imported.skipped} 句`);
  }
  function openImport() { setImportPool(libraryPool); setImportText(''); setImportFormat('text'); setImporting(true); }
  const busy = phase === 'loading' || phase === 'opening';
  const saved = result && data?.favorites.some(f => f.id === result.id);
  const entries = data?.entries.filter(e => e.pool === libraryPool && e.text.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())) || [];
  const pageCount = Math.max(1, Math.ceil(entries.length / 30)), currentPage = Math.min(page, pageCount - 1);
  const shown = entries.slice(currentPage * 30, (currentPage + 1) * 30);
  const favorites = (data?.favorites || []).slice().reverse();

  return <div className="answer-workspace">
    <div className="page-toolbar"><p>一个问题，或只是随手翻开。</p><div className="answer-tabs" role="group" aria-label="答案之书页面">
      {[['book', '翻书', BookOpen], ['library', '句子池', Library], ['favorites', '收藏', Bookmark]].map(([id, label, Icon]) =>
        <Button key={id} className={tab === id ? 'primary' : 'text-button'} aria-pressed={tab === id} onClick={() => setTab(id)}><Icon size={16}/>{label}{id === 'favorites' && data ? ` ${data.favorites.length}` : ''}</Button>)}
    </div></div>
    {error && <div className="alert error" role="alert">{error}<Button onClick={load}>重新读取</Button></div>}
    {!data ? !error && <Empty title="正在打开答案之书…"/> : <>
      {tab === 'book' && <section className="answer-reading-room">
        <div className="answer-shelf-label"><span/>THE BOOK OF ANSWERS<span/></div>
        <div className="answer-stage">
          <BookScene result={result} opening={phase === 'opening'} onOpened={() => setPhase('idle')}/>
          {!result && <Button className="answer-cover-hit" onClick={draw} disabled={busy || !data.available[pool]} aria-label="翻开答案之书"/>}
        </div>
        <div className="answer-result-accessible" role="status" aria-live="polite">{phase === 'loading' ? '正在抽取…' : phase === 'opening' ? '正在翻开…' : result ? result.text : ''}</div>
        {result && phase === 'idle' && <div className="answer-result-actions">
          <Button onClick={() => change({ action: saved ? 'unfavorite' : 'favorite', id: result.id, result, question: result.question })} aria-pressed={!!saved}><Bookmark size={16} fill={saved ? 'currentColor' : 'none'}/>{saved ? '已收藏' : '收藏这一页'}</Button>
          <Button className="text-button" onClick={async () => { await navigator.clipboard.writeText(result.text); toast('答案已复制'); }}><Copy size={16}/>复制</Button>
        </div>}
        <div className="answer-compose">
          <Field label="想问些什么？（可留空）"><textarea rows={2} maxLength={2000} value={question} onChange={e => setQuestion(e.target.value)} placeholder="把问题写在这里，也可以直接翻开"/></Field>
          <div className="answer-draw-controls"><label className="answer-pool-picker"><span>抽取范围</span><select value={pool} onChange={e => setPool(e.target.value)} disabled={busy}>
            {Object.entries(poolLabel).map(([id, label]) => <option key={id} value={id}>{label} · {data.available[id]} 句</option>)}
          </select></label><Button className="primary" onClick={draw} disabled={busy || !data.available[pool]}><BookOpen size={17}/>{phase === 'opening' ? '正在翻开…' : phase === 'loading' ? '正在抽取…' : result ? '再翻一页' : '翻开一页'}</Button></div>
          <p className="answer-storage-note">每句机会相同 · 只保存主动收藏的结果</p>
          {!data.available[pool] && <div className="answer-empty-pool"><p>这个范围还没有启用的句子。</p><div className="actions"><Button onClick={() => { setTab('library'); setLibraryPool('personal'); setEditing({ text: '' }); }}><Plus size={16}/>写下第一句</Button><Button onClick={downloadLibrary}><Download size={16}/>下载通用句库</Button></div></div>}
        </div>
      </section>}

      {tab === 'library' && <section className="panel answer-library">
        <div className="section-heading"><div><h2>你的句子池</h2><p className="muted">句子、停用状态和收藏都保存在本机。</p></div><div className="actions"><Button onClick={load} title="重新读取其它页面的修改"><RotateCcw size={15}/>刷新</Button><Button onClick={openImport}><Upload size={16}/>批量导入</Button><Button className="primary" onClick={() => setEditing({ text: '' })}><Plus size={16}/>添加句子</Button></div></div>
        <div className="filter-bar"><div className="answer-tabs" role="group" aria-label="句库范围">{['personal', 'general'].map(id => <Button key={id} className={libraryPool === id ? 'primary' : 'text-button'} aria-pressed={libraryPool === id} onClick={() => setLibraryPool(id)}>{poolLabel[id]} · {data.entries.filter(e => e.pool === id).length}</Button>)}</div><div className="search-input"><Search size={16}/><input aria-label="搜索句子" placeholder="搜索句子…" value={query} onChange={e => setQuery(e.target.value)}/></div><Button onClick={() => exportFile(`答案之书-${poolLabel[libraryPool]}.json`, { version: 1, entries: data.entries.filter(e => e.pool === libraryPool).map(({ text, enabled }) => ({ text, enabled })) })}><Download size={16}/>导出此句库</Button></div>
        {libraryPool === 'general' && <div className="answer-source"><div><p>通用句库独立下载到本机。</p><small>来源 <a href={data.defaultSource.url} target="_blank" rel="noreferrer">{data.defaultSource.name}</a>{data.sources[0] ? ` · 最近下载 ${fmt(data.sources[0].downloadedAt)}` : ''}</small></div><Button onClick={downloadLibrary}><Download size={15}/>{data.entries.some(e => e.pool === 'general') ? '补充下载' : '下载通用句库'}</Button></div>}
        {shown.length ? <div className="answer-sentence-list">{shown.map(entry => <article className={`answer-sentence ${entry.enabled ? '' : 'is-disabled'}`} key={entry.id}>
          <label className="answer-enable"><input type="checkbox" checked={entry.enabled} aria-label={`${entry.enabled ? '停用' : '启用'}：${entry.text}`} onChange={async e => { const enabled = e.target.checked; try { await change({ action: 'toggle', id: entry.id, enabled }); } catch (err) { toast(err.message, true); } }}/><span>{entry.enabled ? '启用' : '停用'}</span></label>
          <p>{entry.text}</p><div className="actions">{entry.pool === 'personal' ? <><Button className="icon-button" onClick={() => setEditing(entry)} aria-label="编辑句子"><Pencil size={16}/></Button><Button className="icon-button" onClick={() => setRemoving({ kind: 'sentence', ...entry })} aria-label="删除句子"><Trash2 size={16}/></Button></> : <Button className="text-button" onClick={() => setEditing({ text: entry.text })}>另存为我的句子</Button>}</div>
        </article>)}</div> : <Empty title={query ? '没有找到匹配的句子' : '这里还没有句子'}>可以添加一句，也可以一次导入多句。</Empty>}
        <div className="answer-pagination"><small>共 {entries.length} 句 · 停用的句子不参与抽取</small><div className="actions"><Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button><span>{currentPage + 1} / {pageCount}</span><Button disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</Button></div></div>
      </section>}

      {tab === 'favorites' && <><div className="page-toolbar"><p>留下你想再读一次的页面。</p><Button disabled={!favorites.length} onClick={() => exportFile('答案之书-收藏.json', { version: 1, favorites: data.favorites })}><Download size={16}/>导出收藏</Button></div>
        {favorites.length ? <div className="answer-favorites">{favorites.map(item => <article className="answer-favorite" key={item.id}><small>{fmt(item.createdAt)} · {poolLabel[item.pool]}</small>{item.question && <p className="answer-favorite-question">{item.question}</p>}<blockquote>{item.text}</blockquote><div className="actions"><Button className="text-button" onClick={async () => { await navigator.clipboard.writeText([item.question, item.text].filter(Boolean).join('\n\n')); toast('已复制'); }}><Copy size={16}/>复制</Button><Button className="text-button" onClick={() => setRemoving({ kind: 'favorite', ...item })}><Bookmark size={16}/>取消收藏</Button></div></article>)}</div> : <Empty title="收藏的页面会留在这里">翻开后，点「收藏这一页」即可保存。</Empty>}</>}
    </>}

    {editing && <Dialog title={editing.id ? '编辑句子' : '添加到我的句子'} onClose={() => setEditing(null)}><Form onSave={async form => {
      const response = await change({ action: editing.id ? 'edit' : 'add', id: editing.id, expectedText: editing.text, text: form.get('text') });
      setEditing(null); toast(response.skipped ? '我的句子中已有这句话' : '句子已保存');
    }}><Field label="句子"><textarea name="text" rows={5} defaultValue={editing.text} required maxLength={600} autoFocus/></Field></Form></Dialog>}
    {importing && <Dialog title="批量导入句子" onClose={() => setImporting(false)} wide><Form submit="导入到本机" onSave={async () => {
      const response = await change({ action: 'import', pool: importPool, content: importText, format: importFormat });
      setImporting(false); setLibraryPool(importPool); setQuery(''); setPage(0); toast(`新增 ${response.added} 句，跳过重复 ${response.skipped} 句`);
    }}><Field label="放入哪个句库"><select value={importPool} onChange={e => setImportPool(e.target.value)}><option value="personal">我的句子</option><option value="general">通用句库</option></select></Field>
      <Field label="选择 TXT / JSON 文件" hint="支持 UTF-8 文件，最多 800 KB。也可以直接粘贴文字，每行一句。"><input type="file" accept=".txt,.json,text/plain,application/json" onChange={async e => {
        const file = e.target.files[0]; if (!file) return;
        try { if (file.size > 800000) throw new Error('请选择 800 KB 以内的文件'); const text = await file.text(); setImportText(text); setImportFormat(file.name.toLowerCase().endsWith('.json') ? 'json' : 'text'); } catch (err) { toast(err.message, true); }
        e.target.value = '';
      }}/></Field>
      <Field label="格式"><select value={importFormat} onChange={e => setImportFormat(e.target.value)}><option value="text">每行一句</option><option value="json">JSON 句库</option></select></Field>
      <Field label="导入内容" hint="重复句子会跳过，已有句子的停用状态保持不变。"><textarea rows={10} required value={importText} onChange={e => setImportText(e.target.value)}/></Field>
    </Form></Dialog>}
    {removing && <Dialog title={removing.kind === 'favorite' ? '取消这条收藏？' : '删除这句？'} onClose={() => setRemoving(null)}><p className="preserve-lines">{removing.text}</p><div className="form-actions"><Button onClick={() => setRemoving(null)}>保留</Button><Button className="primary" onClick={async () => { await change({ action: removing.kind === 'favorite' ? 'unfavorite' : 'delete', id: removing.id }); setRemoving(null); }}>确认{removing.kind === 'favorite' ? '取消收藏' : '删除'}</Button></div></Dialog>}
  </div>;
}
