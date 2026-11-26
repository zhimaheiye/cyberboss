const fs = require('node:fs');
const path = require('node:path');
const { writeJson } = require('./store');
const starters = require('./starter-playbook');

function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
}
function string(value, max, optional = false) {
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) throw new Error('请检查未填写或过长的内容');
  return value.trim();
}
function unique(items, max) {
  if (!Array.isArray(items) || !items.length || items.length > max || new Set(items.map(i => i.id)).size !== items.length)
    throw new Error('卡点或方法的数量、编号有误');
  for (const item of items) if (!/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)) throw new Error('编号无效');
  return items;
}
function suggestion(doc) {
  return { ref:doc.ref, title:doc.title, source:doc.source, snippet:(doc.snippet || doc.text || '').slice(0, 360) };
}
class Procrastination {
  constructor(app) {
    this.app = app;
    this.dir = path.join(app.store.dir, 'procrastination');
  }
  book() {
    const book = read(path.join(this.dir, 'playbook.json'), { revision:0, reasons:starters });
    for (const reason of book.reasons) {
      const defaults = starters.find(item => item.id === reason.id);
      if (!defaults) continue;
      reason.strategies = reason.strategies.map(strategy => {
        const fallback = defaults.strategies.find(item => item.id === strategy.id);
        return !strategy.personal && fallback
          ? { ...strategy, label:fallback.label, steps:fallback.steps }
          : strategy;
      });
    }
    return book;
  }
  history() { return read(path.join(this.dir, 'history.json'), []); }
  stats(history = this.history()) {
    const stats = {};
    for (const entry of history) {
      const key = entry.reasonId + '/' + entry.strategyId;
      const row = stats[key] ||= { started:0, stuck:0, deferred:0 };
      row[entry.outcome]++;
    }
    return stats;
  }
  view() { return { ...this.book(), stats:this.stats() }; }
  save(input) {
    const current = this.book();
    if (input.revision !== current.revision) throw new Error('速查表已在别处更新，请重新读取后保存');
    const reasons = unique(input.reasons, 60).map(r => {
      const strategies = unique(r.strategies, 40).map(s => {
        if (!Array.isArray(s.steps) || !s.steps.length || s.steps.length > 15) throw new Error('每个方法需有 1～15 个可选范围');
        return { id:s.id, label:string(s.label, 120), enabled:!!s.enabled, personal:!!s.personal,
          steps:s.steps.map(step => string(step, 600)) };
      });
      if (r.enabled && !strategies.some(s => s.enabled)) throw new Error('启用的卡点至少需要一个启用的方法');
      if (!Array.isArray(r.pins) || r.pins.length > 40) throw new Error('每个卡点最多固定 40 个资源');
      return { id:r.id, title:string(r.title, 120), question:string(r.question, 300, true), enabled:!!r.enabled,
        strategies, pins:[...new Set(r.pins.map(ref => string(ref, 1000)))] };
    });
    if (!reasons.some(r => r.enabled)) throw new Error('请至少启用一个卡点');
    writeJson(path.join(this.dir, 'playbook.json'), { revision:current.revision + 1, reasons });
    return this.view();
  }
  feedback(input) {
    const book = this.book(), reason = book.reasons.find(r => r.id === input.reasonId);
    if (!reason?.strategies.some(s => s.id === input.strategyId) || !['started','stuck','deferred'].includes(input.outcome))
      throw new Error('卡点、方法或反馈无效，请重新打开速查表');
    const history = this.history(), id = string(input.id, 80);
    if (!history.some(e => e.id === id)) {
      history.push({ id, at:new Date().toISOString(), reasonId:reason.id, strategyId:input.strategyId, outcome:input.outcome,
        taskId:string(input.taskId || '', 120, true), subject:string(input.subject || '', 500, true), step:string(input.step, 600) });
      writeJson(path.join(this.dir, 'history.json'), history);
    }
    return this.stats(history);
  }
  async resources({ reasonId, query, taskId }) {
    const reason = this.book().reasons.find(r => r.id === reasonId);
    if (!reason) throw new Error('卡点已变化，请重新读取');
    const source = taskId ? 'task:' + encodeURIComponent(taskId) : null;
    const items = new Map(), warnings = [];
    let linked = [];
    if (source) {
      try {
        linked = this.app.toolbox.load().links.filter(l => l.status === 'confirmed' && [l.fromRef,l.toRef].includes(source))
          .map(l => l.fromRef === source ? l.toRef : l.fromRef);
      } catch { warnings.push('待办的工具关联暂时无法读取'); }
    }
    const attach = async ref => {
      try {
        const doc = await this.app.retrieval.sources.read(ref);
        return doc.archived ? null : suggestion(doc);
      } catch { warnings.push('一个关联资源暂时无法读取'); return null; }
    };
    const refs = [...new Set([...reason.pins, ...linked.slice(0, 8)])];
    for (const item of await Promise.all(refs.map(attach))) if (item) items.set(item.ref,item);
    if (query?.trim()) {
      const keyword = string(query, 2000);
      try {
        const found = await this.app.retrieval.search({ query:keyword, mode:'keyword', sources:['tool','note','chat','job','reference'], limit:6 });
        for (const doc of found.items) if (!items.has(doc.ref)) items.set(doc.ref, suggestion(doc));
        warnings.push(...found.warnings);
      } catch (error) { warnings.push('本机检索未完成：' + error.message); }
    }
    return { items:[...items.values()], warnings:[...new Set(warnings)] };
  }
}
module.exports = { Procrastination };
