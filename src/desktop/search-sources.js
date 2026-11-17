const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { observationKind } = require('./observations');
const SOURCES = ['task', 'tool', 'job', 'event', 'chat', 'note', 'decision', 'reference', 'run', 'skill', 'task-event', 'answer', 'favorite', 'breathing'];
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const encode = id => encodeURIComponent(String(id));
function document(source, id, title, text, date, page, archived = false) {
  const content = String(text || '');
  return { ref: `${source}:${encode(id)}`, source, id: String(id), title: String(title || '未命名记录'), text: content,
    date: date || null, page, archived, hash: hash(JSON.stringify([title, content, archived])) };
}
class SearchSources {
  constructor(app) { this.app = app; this.taskCache = null; }
  invalidateTasks() { this.taskCache = null; }
  async tasks() {
    if (this.taskCache && Date.now() - this.taskCache.at < 30000) return this.taskCache.result;
    const revision = this.app.taskRevision, rows = [], seen = new Set(); let cursor;
    do {
      const result = await this.app.todo.call('list_tasks', { view: 'all', include_completed: true, limit: 200, timezone: 'Asia/Shanghai', ...(cursor ? { cursor } : {}) });
      rows.push(...result.tasks); cursor = result.next_cursor;
      if (cursor && seen.has(cursor)) throw new Error('待办分页返回重复游标');
      seen.add(cursor);
    } while (cursor);
    const docs = []; let unavailable = 0;
    for (let i = 0; i < rows.length; i += 6) {
      const batch = await Promise.all(rows.slice(i, i + 6).map(async row => {
        try {
          const { task } = await this.app.todo.call('get_task', { id: row.id, timezone: 'Asia/Shanghai' });
          return this.taskDocument(task);
        } catch { unavailable++; return null; }
      }));
      docs.push(...batch.filter(Boolean));
    }
    const result = { docs, warnings: unavailable ? [`${unavailable} 条待办详情暂时无法读取，本次未纳入检索`] : [] };
    if (revision === this.app.taskRevision && !unavailable) this.taskCache = { at: Date.now(), result };
    return result;
  }
  taskDocument(t) {
    return document('task', t.id, t.untrusted_text?.title || t.title,
      [t.untrusted_text?.description || t.description, `状态：${t.completed ? '已完成' : '未完成'}`,
        t.due && `计划日期：${t.due.date} ${t.due.time || ''}`, t.recurrence && `周期：${t.recurrence}`].filter(Boolean).join('\n'), t.completed_at || t.created_at, 'tasks');
  }
  async collect(selected = SOURCES) {
    const docs = [], warnings = [], a = this.app, d = a.store.data;
    const push = (...args) => docs.push(document(...args));
    for (const source of selected) {
      try {
        if (source === 'task') { const result = await this.tasks(); docs.push(...result.docs); warnings.push(...result.warnings); }
        if (source === 'tool') for (const t of a.toolbox.load().tools) push(source, t.id, t.title,
          [t.description, `适用场景：${t.whenToUse}`, `限制：${t.constraints}`, `入口：${t.locator}`, `状态：${t.availability}`, ...t.tags, ...t.aliases].join('\n'), t.updatedAt, 'tools', t.archived);
        if (source === 'job') for (const j of d.jobs) push(source, j.id, j.title,
          [j.instructions, j.notificationText, j.contexts, `状态：${j.status}`, JSON.stringify(j.schedule), j.blocker?.evidence,
            d.workStates?.[j.id] && `持续进展：${JSON.stringify(d.workStates[j.id])}`].filter(Boolean).join('\n'), d.workStates?.[j.id]?.updatedAt || j.createdAt, 'jobs', j.status === 'done');
        if (source === 'event') for (const e of d.observations) push(source, e.id, e.text.slice(0, 60), `${e.text}\n记录分类：${observationKind(e) === 'execution' ? 'Agent 执行记录' : '生活观察'}\n来源：${e.source}\n依据类型：${e.evidence}`, e.observedAt, 'timeline');
        if (source === 'event') for (const e of d.workEvents || []) push(source, `work-${e.id}`, d.jobs.find(j => j.id === e.jobId)?.title || '托管事项事件',
          JSON.stringify({ kind: e.kind, actor: e.actor, source: e.source, data: e.data, progress: e.progress, outcome: e.outcome }), e.createdAt, 'jobs');
        if (source === 'chat') for (const m of d.messages) push(source, m.id, `${m.role} · ${m.kind || '对话'}`, [m.text, ...(m.images || []).map(i => `图片附件：${i.name || i.id}（仅附件名称参与文本检索）`)].filter(Boolean).join('\n'), m.createdAt, 'chat');
        if (source === 'note') {
          const dir = path.join(a.store.dir, 'memory');
          for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.md'))) push(source, name, name, fs.readFileSync(path.join(dir, name), 'utf8'), fs.statSync(path.join(dir, name)).mtime.toISOString(), 'memory');
        }
        if (source === 'decision') for (const s of a.decisionGuide.read().scenarios) push(source, s.id, s.title,
          [s.description, ...s.nodes.map(n => [n.id, n.text, n.detail, ...(n.options || []).map(o => `${o.label} → ${o.next}`)].filter(Boolean).join('\n'))].join('\n\n'), null, 'decisions');
        if (source === 'reference') for (const r of a.decisionGuide.references()) push(source, r.name, r.title, a.decisionGuide.reference(r.name).text, null, 'decisions');
        if (source === 'run') for (const r of d.runs) push(source, r.id, d.jobs.find(j => j.id === r.jobId)?.title || (r.background ? '自然唤醒记录' : '对话执行记录'),
          [r.status, r.action, r.note, r.error, r.learningOutcome].filter(Boolean).join('\n'), r.createdAt, 'jobs');
        if (source === 'skill') for (const id of Object.keys(d.learnedSkills || {})) {
          const s = a.skills.read(id); if (s) push(source, id, s.title, `${s.status}\n${s.text}`, s.lastSuccessAt, 'jobs');
        }
        if (source === 'task-event') for (const e of d.taskEvents || []) {
          if (['receipt', 'requested'].includes(e.action)) continue;
          push(source, e.id, e.title || '任务状态记录', [e.action, `操作者：${e.actor}`, e.evidence, e.userQuote, e.completedAt, e.taskId && `taskId:${e.taskId}`].filter(Boolean).join('\n'), e.createdAt, 'timeline');
        }
        if (source === 'answer') for (const e of a.answerBook.read().entries) push(source, e.id, e.text.slice(0, 60), `${e.text}\n${e.pool}\n${e.source}`, e.createdAt, 'answer-book', !e.enabled);
        if (source === 'favorite') for (const e of a.answerBook.read().favorites) push(source, e.id, e.question || '收藏的答案', `${e.question || ''}\n${e.text}`, e.createdAt, 'answer-book');
        if (source === 'breathing') for (const r of d.breathing?.records || []) push(source, r.id, '呼吸练习记录', JSON.stringify({ activeMs: r.activeMs, mode: r.mode, outcome: r.outcome, feedback: r.feedback }), new Date(r.startedAt).toISOString(), 'timeline');
      } catch { warnings.push(`${source} 来源暂时无法完整读取`); }
    }
    return { docs, warnings, collectedAt: new Date().toISOString() };
  }
  async read(ref) {
    if (typeof ref !== 'string' || ref.length > 1000) throw new Error('来源标识无效');
    const index = ref.indexOf(':'), source = ref.slice(0, index), id = decodeURIComponent(ref.slice(index + 1));
    if (!SOURCES.includes(source)) throw new Error('未知来源');
    if (source === 'task') {
      const { task } = await this.app.todo.call('get_task', { id, timezone: 'Asia/Shanghai' });
      return this.taskDocument(task);
    }
    const { docs } = await this.collect([source]), doc = docs.find(item => item.ref === ref);
    if (!doc) throw new Error('原记录已不存在或暂时不可读取');
    return doc;
  }
}
module.exports = { SearchSources, SOURCES, hash };
