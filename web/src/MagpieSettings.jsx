import React, { useEffect, useState } from 'react';
import { api, Button, Form, Field, Badge, useWorkbench } from './shared';
export function MagpieModelField({ model, onChange, models = [], allowDefault = false, defaultModel = '' }) {
  const [manual,setManual] = useState(false);
  return <Field label={allowDefault ? '此事项的 Magpie 模型' : '默认 Magpie 模型'}>
    <select value={manual ? '__manual__' : model} onChange={e=>{if(e.target.value==='__manual__')setManual(true);else{setManual(false);onChange(e.target.value);}}}>
      <option value="">{allowDefault ? `沿用默认模型${defaultModel ? ` · ${defaultModel}` : ''}` : '请选择模型'}</option>
      {model && !models.some(m=>m.id===model) && <option value={model}>{model}</option>}
      {models.map(m=><option key={m.id} value={m.id}>{m.name || m.id}</option>)}
      <option value="__manual__">手动填写模型 ID…</option>
    </select>
    {manual && <input aria-label="Magpie 模型 ID" value={model} onChange={e=>onChange(e.target.value)} maxLength={200} placeholder="模型 ID"/>}
  </Field>;
}
export default function MagpieSettings() {
  const { refresh,toast }=useWorkbench(), [c,setC]=useState(null), [error,setError]=useState(''), [secret,setSecret]=useState(''), [clearKey,setClearKey]=useState(false), [models,setModels]=useState([]);
  useEffect(()=>{let alive=true;api('magpie').then(v=>{if(alive){setC(v);setModels(v.models);}}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[]);
  const set=(key,value)=>setC(old=>({...old,[key]:value}));
  return <section className="panel settings-wide"><div className="section-heading"><h2>Magpie · 低成本模型</h2><Badge>{c?.enabled?'已启用':'尚未启用'}</Badge></div>
    <p>通过本机 Magpie 管理 API。主对话继续使用 Codex，托管事项可选择执行方式。</p>
    {error&&<p className="alert error">{error}</p>}{c&&<Form submit="保存 Magpie 设置" onSave={async()=>{
      const next=await api('magpie',{...c,action:'save',apiKey:secret,clearKey});setC(next);setSecret('');setClearKey(false);await refresh();toast('Magpie 设置已保存，下次执行生效');
    }}>
      <label className="switch-row"><span><strong>启用 Magpie</strong><small>允许选定事项及主 Agent 的文本委派使用该接口</small></span><input type="checkbox" role="switch" checked={c.enabled} onChange={e=>set('enabled',e.target.checked)}/></label>
      <Field label="Magpie 服务地址"><input type="url" value={c.endpoint} onChange={e=>{set('endpoint',e.target.value);setModels([]);}} required/></Field>
      <Field label={c.hasKey?'API Key（已保存，留空保留）':'API Key（本机服务无需鉴权时留空）'}><input type="password" autoComplete="new-password" value={secret} onChange={e=>setSecret(e.target.value)}/></Field>
      {c.hasKey&&<label className="check"><input type="checkbox" checked={clearKey} onChange={e=>setClearKey(e.target.checked)}/>清除密钥</label>}
      <div className="actions"><Button onClick={async()=>{const result=await api('magpie',{action:'models',endpoint:c.endpoint,apiKey:secret,clearKey});setModels(result.models);toast(`已拉取 ${result.models.length} 个 Magpie 模型`);}}>拉取模型</Button><small>使用上方填写的地址和密钥；此操作不调用模型</small></div>
      <MagpieModelField model={c.model} onChange={v=>set('model',v)} models={models}/>
      <div className="field-pair"><Field label="每次托管任务最多请求模型几次"><input type="number" min="1" max="20" value={c.maxRounds} onChange={e=>set('maxRounds',Number(e.target.value))}/></Field><Field label="单次输出上限（tokens）"><input type="number" min="256" max="16384" value={c.maxTokens} onChange={e=>set('maxTokens',Number(e.target.value))}/></Field></div>
      <label className="check"><input type="checkbox" checked={c.fallback} onChange={e=>set('fallback',e.target.checked)}/>失败、能力不足或核验未完成时，交回 Codex 继续</label>
      <p className="hint">保存后，在「交给 Agent → 编辑」选择执行方式。自动模式仅在技能可复用时使用 Magpie，其余交给 Codex。模型价格与路由由 Magpie 管理。任务材料和工具结果会发送到所选模型；密钥只保存在本机数据目录。</p>
    </Form>}
  </section>;
}
