import React, { useEffect, useState } from 'react';
import { api, Button, Form, Field, fmt, useWorkbench } from './shared';
export default function PromptPreferences() {
  const { toast } = useWorkbench(), [data,setData] = useState(null), [text,setText] = useState(''), [error,setError] = useState('');
  useEffect(() => { let disposed=false; api('preferences').then(r => { if (!disposed) {setData(r);setText(r.text);} }).catch(e => {if(!disposed)setError(e.message);}); return () => {disposed=true;}; }, []);
  return <section className="panel settings-wide"><h2>Agent 的个人工作偏好</h2><p>保存你希望它长期遵循的表达和工作习惯。下次执行生效，默认指令升级时保留你的文本。</p>
    {error && <div className="alert error">{error}</div>}
    {data && <><Form submit="保存偏好" onSave={async () => {const next=await api('preferences',{version:data.version,text});setData(next);setText(next.text);toast('偏好已保存，下次执行生效');}}><Field label="我的偏好"><textarea value={text} onChange={e=>setText(e.target.value)} rows={6} maxLength={16000}/></Field></Form>
      {data.defaultChanged && <p className="hint">项目默认指令已更新。下面可以查看当前默认指令，以及历史保存时的版本。</p>}
      <details><summary>当前默认指令 · {data.defaultVersion}</summary><pre>{data.defaults}</pre></details>
      <details><summary>偏好历史 · {data.versions.length} 个版本</summary>{data.versions.slice().reverse().map(v=><article className="work-event" key={v.version}><small>v{v.version} · {fmt(v.createdAt)}</small><pre>{v.text || '（空）'}</pre><Button onClick={()=>{setText(v.text);toast('已载入编辑框，保存后形成新版本');}}>载入此版本</Button><details><summary>当时的默认指令</summary><pre>{v.defaultText}</pre></details></article>)}</details></>}
  </section>;
}
