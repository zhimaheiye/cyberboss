import React, { useState } from 'react';
import { Button, Dialog, Field, Form, api } from './shared';

export const makeMethod = () => ({ id:crypto.randomUUID(), label:'我的方法', steps:['写下一个可以动手的动作'], enabled:true, personal:true });
const makeReason = () => ({ id:crypto.randomUUID(), title:'我的卡点', question:'哪种做法比较顺手？', enabled:true, pins:[], strategies:[makeMethod()] });
function move(items, index, delta) {
  const result = items.slice();
  [result[index], result[index + delta]] = [result[index + delta], result[index]];
  return result;
}
function Order({ index, length, change }) {
  return <div className="actions"><Button disabled={!index} onClick={() => change(-1)}>上移</Button>
    <Button disabled={index === length - 1} onClick={() => change(1)}>下移</Button></div>;
}
export default function PlaybookEditor({ book, initialId, saved, close }) {
  const [original] = useState(book);
  const [reasons,setReasons] = useState(() => structuredClone(book.reasons));
  const [selected,select] = useState(initialId || reasons[0].id);
  const index = reasons.findIndex(r => r.id === selected), reason = reasons[index];
  function update(patch) { setReasons(reasons.map(r => r.id === selected ? {...r,...patch} : r)); }
  function method(i, patch) { update({ strategies:reason.strategies.map((s,n) => i === n ? {...s,...patch,personal:true} : s) }); }
  return <Dialog title="编辑我的速查表" wide onClose={close}><Form submit="保存速查表" onSave={async()=>{
    const next = await api('procrastination',{action:'save', revision:original.revision, reasons});
    saved(next); close();
  }}>
    <div className="actions"><select aria-label="选择要编辑的卡点" value={selected} onChange={e=>select(e.target.value)}>
      {reasons.map(r=><option key={r.id} value={r.id}>{r.title}{r.enabled?'':'（停用）'}</option>)}</select>
      <Button onClick={()=>{const r=makeReason();setReasons([...reasons,r]);select(r.id);}}>添加卡点</Button></div>
    <Field label="卡点"><input value={reason.title} maxLength={120} required onChange={e=>update({title:e.target.value})}/></Field>
    <Field label="选择方法时的问题"><input value={reason.question} maxLength={300} onChange={e=>update({question:e.target.value})}/></Field>
    <div className="actions"><label className="check"><input type="checkbox" checked={reason.enabled} onChange={e=>update({enabled:e.target.checked})}/>启用这个卡点</label>
      <Order index={index} length={reasons.length} change={delta=>setReasons(move(reasons,index,delta))}/></div>
    {reason.strategies.map((s,i)=><section className="panel" key={s.id}>
      <Field label="方法名称"><input required maxLength={120} value={s.label} onChange={e=>method(i,{label:e.target.value})}/></Field>
      <Field label="行动步骤（每行一句，越往下越小）"><textarea rows={4} value={s.steps.join('\n')} onChange={e=>method(i,{steps:e.target.value.split('\n')})}/></Field>
      <div className="actions"><label className="check"><input type="checkbox" checked={s.enabled} onChange={e=>method(i,{enabled:e.target.checked})}/>启用</label>
        <Order index={i} length={reason.strategies.length} change={delta=>update({strategies:move(reason.strategies,i,delta)})}/></div>
    </section>)}
    <Button onClick={()=>update({strategies:[...reason.strategies,makeMethod()]})}>添加方法</Button>
    {reason.pins.length>0&&<details><summary>固定的资源 · {reason.pins.length}</summary>{reason.pins.map(ref=><div key={ref} className="actions"><code>{ref}</code>
      <Button onClick={()=>update({pins:reason.pins.filter(item=>item!==ref)})}>取消固定</Button></div>)}</details>}
  </Form></Dialog>;
}
