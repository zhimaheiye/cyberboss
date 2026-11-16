import React, { useEffect, useState } from 'react';
import { useWorkbench, api, Button, Form, Field, Badge, fmt } from './shared';
import { sourceNames } from './Search';
export default function RetrievalSettings() {
  const { state, toast } = useWorkbench(), [data, setData] = useState(null), [error, setError] = useState(''), [key, setKey] = useState(0);
  useEffect(() => { let alive = true; api('retrieval').then(d => { if (alive) { setData(d); setError(''); } }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, [state.indexing]);
  async function action(value) { const result = await api('retrieval', value); setData(await api('retrieval')); return result; }
  return <section className="panel settings-wide"><div className="section-heading"><h2>统一检索与向量模型</h2><Badge>{data?.config.enabled ? '向量检索已启用' : '关键词检索可用'}</Badge></div>
    {error && <p className="alert error">{error}</p>}{data && <><Form key={key} submit="保存向量设置" onSave={async d => {
      await action({ action: 'save', enabled: d.get('enabled') === 'on', endpoint: d.get('endpoint'), model: d.get('model'), apiKey: d.get('apiKey'), clearKey: d.get('clearKey') === 'on', dimensions: d.get('dimensions'), chunkSize: Number(d.get('chunkSize')), batchSize: Number(d.get('batchSize')), autoIndex: d.get('autoIndex') === 'on', sources: d.getAll('sources') });
      setKey(k => k + 1); toast('向量设置已保存');
    }}><label className="switch-row"><span><strong>启用向量检索</strong><small>与关键词检索一起使用</small></span><input type="checkbox" name="enabled" role="switch" defaultChecked={data.config.enabled}/></label>
      <Field label="接口地址（OpenAI 兼容 embeddings）" name="endpoint" type="url" defaultValue={data.config.endpoint} placeholder="http://127.0.0.1:端口/v1 或完整 /embeddings 地址"/>
      <Field label="向量模型名称" name="model" defaultValue={data.config.model} maxLength={200}/><Field label={data.config.hasKey ? 'API Key（已保存，留空保留）' : 'API Key（本机接口可留空）'} name="apiKey" type="password" autoComplete="new-password"/>
      {data.config.hasKey && <><label className="check"><input name="clearKey" type="checkbox"/>清除已保存密钥</label><p className="hint">更换接口地址时请重新填写密钥，旧密钥不会带到新地址。</p></>}
      <div className="field-pair"><Field label="向量维度（可留空）" name="dimensions" type="number" min="1" max="65536" defaultValue={data.config.dimensions || ''}/><Field label="每批片段数" name="batchSize" type="number" min="1" max="32" defaultValue={data.config.batchSize}/></div>
      <Field label="每段字符数" name="chunkSize" type="number" min="300" max="4000" defaultValue={data.config.chunkSize}/>
      <Field label="参与向量化的来源"><div className="source-checkboxes">{data.sources.map(id => <label className="check" key={id}><input type="checkbox" name="sources" value={id} defaultChecked={data.config.sources.includes(id)}/>{sourceNames[id]}</label>)}</div></Field>
      <label className="check"><input name="autoIndex" type="checkbox" defaultChecked={data.config.autoIndex}/>搜索时自动更新新增或变化的片段</label>
      <p className="hint">向量化会把所选内容的文本和搜索词发送到上面配置的接口。配置与索引保存在本机数据目录；密钥不会返回给 Agent 或进入检索内容。图片目前仅检索附件名称。保存配置不会立即开始全文向量化。</p>
    </Form><div className="actions"><Button onClick={async () => { const r = await action({ action: 'test' }); toast(`${r.message} · ${r.dimensions} 维`); }}>测试已保存的接口</Button>
      <Button disabled={!data.config.enabled || data.busy} onClick={() => action({ action: 'index' })}>更新索引</Button><Button disabled={!data.config.enabled || data.busy} onClick={() => action({ action: 'index', force: true })}>全部重新向量化</Button>
      {data.busy && <Button onClick={() => action({ action: 'cancel' })}>停止更新</Button>}</div>
      <p className="hint">{data.busy ? `正在更新：${data.done} / ${data.total} 片段` : `已存 ${data.indexedChunks} 个有效配置下的片段`} · 最近更新 {fmt(data.indexedAt)}</p>
      {Object.keys(data.chunksBySource || {}).length > 0 && <details><summary>片段来源</summary><div className="source-checkboxes">{Object.entries(data.chunksBySource).map(([source, count]) => <span key={source}>{sourceNames[source] || source}：{count}</span>)}</div><p className="hint">这里统计已保存的向量片段，包含句库等资料；片段数与任务数不同。</p></details>}
      {data.busy && data.total > 0 && <progress value={data.done} max={data.total}/>}{data.error && <p className="alert error">{data.error}</p>}{data.warnings?.map((w, i) => <p className="hint" key={i}>{w}</p>)}
    </>}
  </section>;
}
