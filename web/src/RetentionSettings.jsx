import React, { useState } from 'react';
import { api, tool, useWorkbench, Form, Field, Button, Badge, fmt } from './shared';

export default function RetentionSettings() {
  const { state, refresh, toast } = useWorkbench(), data = state.retention;
  const [preview, setPreview] = useState(null);
  if (!data) return null;
  return <section className="panel settings-wide"><div className="section-heading"><h2>巡检记录保留</h2><Badge>{data.enabled ? '后台自动整理' : '已关闭'}</Badge></div>
    <Form key={`${data.enabled}:${data.keepDays}`} submit="保存保留策略" onSave={async fields => {
      await api('retention', { enabled: fields.get('enabled') === 'on', keepDays: Number(fields.get('keepDays')) });
      setPreview(null); await refresh(); toast('保留策略已保存，工作台会在空闲时处理');
    }}><label className="check"><input name="enabled" type="checkbox" defaultChecked={data.enabled}/>定期清理正常巡检记录</label>
      <Field label="保留最近多少天" name="keepDays" type="number" min="1" max="365" defaultValue={data.keepDays} required/>
      <p className="hint">工作台进程每天检查一次，等待 Agent 和向量索引空闲后处理。清理超过保留期的正常静默巡检及其操作记录、对应向量，保留简短统计。异常、待核查、每项最新一轮，以及技能、关联、任务历史引用的记录继续保留。</p>
      <p className="hint">对话、提醒、生活观察、任务、笔记和句库保留。Codex 会话另外按下方规则自动归档。</p>
    </Form><div className="actions"><Button onClick={async () => setPreview({ ...await tool('cb_retention', { action: 'preview' }), at: new Date().toISOString() })}>查看可清理数量</Button>
      <Button disabled={!data.enabled} onClick={async () => { const result = await tool('cb_retention', { action: 'request' }); await refresh(); toast(result.message || result.reason); }}>安排一次后台检查</Button></div>
    {preview && <p className="hint">{fmt(preview.at)} 的预估：{preview.runs} 次执行、{preview.observations} 条操作记录、{preview.vectors} 个向量片段；执行时会重新判断。</p>}
    <p className="hint">上次检查 {fmt(data.lastCheckedAt)} · {data.requestedAt ? '已安排，等待空闲' : data.enabled ? `下次检查 ${data.nextCheckAt ? fmt(data.nextCheckAt) : '首次空闲时'}` : '自动检查已关闭'}</p>
    {data.error && <p className="alert error">清理未完成：{data.error}</p>}
    {data.lastSummary && <p className="hint">最近清理 {fmt(data.lastSummary.at)}：{data.lastSummary.runs} 次执行、{data.lastSummary.observations} 条操作记录、{data.lastSummary.vectors} 个向量片段。</p>}
    {data.history?.length > 0 && <details><summary>清理统计</summary>{[...data.history].reverse().map(item => <p className="hint" key={item.at}>{fmt(item.at)} · {item.runs} 次执行 / {item.observations} 条记录 / {item.vectors} 个向量</p>)}</details>}
    {state.threadMaintenance && <ThreadMaintenanceStatus data={state.threadMaintenance}/>}
  </section>;
}

function ThreadMaintenanceStatus({ data }) {
  return <div className="stack"><h3>Codex 会话整理</h3>
    <p className="hint">按主对话、自然唤醒和任务名称命名。每天空闲时检查，已替换或所属任务已完成、已删除的会话，连续 {data.keepDays} 天没有活动后归档。历史内容保留，执行详情仍可查阅。正在执行、主对话、自然唤醒和仍需复用的任务会话继续保留，暂停或阻塞的任务也保留。</p>
    <p className="hint">已登记 {data.tracked} 个会话 · 已归档 {data.archived} 个 · {data.busy ? '正在整理' : `上次检查 ${fmt(data.lastCheckedAt)}`}</p>
    <p className="hint">下次检查：{data.nextCheckAt ? fmt(data.nextCheckAt) : '首次空闲时'}。整理失败会记录原因，在下次日检查时重试。</p>
    {data.error && <p className="alert error">会话整理未完成：{data.error}</p>}
    {data.errors?.map(item => <p className="alert error" key={item.id}>{item.name}：{item.error}</p>)}
    {data.history?.length > 0 && <details><summary>会话整理记录</summary>{[...data.history].reverse().map((item, i) => <p className="hint" key={`${item.at}:${i}`}>{fmt(item.at)} · 命名 {item.renamed} 个 / 归档 {item.archived} 个 / 失败 {item.failed} 个</p>)}</details>}
  </div>;
}
