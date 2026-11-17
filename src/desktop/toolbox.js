const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJson } = require('./store');
const str = (value, max = 6000) => {
  if (typeof value !== 'string' || value.length > max) throw new Error('文字格式不正确或过长');
  return value.trim();
};
const tags = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,，\n]/)).map(v => str(v, 80)).filter(Boolean))].slice(0, 30);
class Toolbox {
  constructor(store) { this.store = store; this.file = path.join(store.dir, 'toolbox.json'); this.revision = 0; }
  load() {
    const data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, tools: [], links: [] };
    if (data.version !== 1 || !Array.isArray(data.tools) || !Array.isArray(data.links)) throw new Error('工具箱文件格式无法读取，原文件保留');
    return data;
  }
  save(data) { writeJson(this.file, data); this.revision++; }
  async invoke(args, actor = 'agent') {
    const data = this.load();
    if (args.action === 'list') {
      const q = str(args.query || '', 2000).toLocaleLowerCase();
      const items = data.tools.filter(t => (args.includeArchived || !t.archived) && (!q || JSON.stringify(t).toLocaleLowerCase().includes(q)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      return { items: items.slice(offset, offset + 50), nextOffset: offset + 50 < items.length ? offset + 50 : null, total: items.length };
    }
    if (args.action === 'get') {
      const tool = data.tools.find(t => t.id === args.id); if (!tool) throw new Error('工具条目不存在'); return tool;
    }
    if (args.action === 'save') {
      const input = args.tool || {}, old = input.id ? data.tools.find(t => t.id === input.id) : null;
      if (input.id && !old) throw new Error('工具条目不存在');
      if (old && input.version !== old.version) throw new Error('工具已修改，请重新读取后保存');
      const merged = { ...old, ...input }, now = new Date().toISOString();
      if (!['unknown', 'available', 'limited', 'unavailable'].includes(merged.availability || 'unknown')) throw new Error('可用状态无效');
      const tool = { id: old?.id || crypto.randomUUID(), version: (old?.version || 0) + 1,
        title: str(merged.title || '', 200), description: str(merged.description || '', 20000), whenToUse: str(merged.whenToUse || ''),
        constraints: str(merged.constraints || ''), locator: str(merged.locator || '', 2000), tags: tags(merged.tags), aliases: tags(merged.aliases),
        availability: merged.availability || 'unknown', archived: merged.archived === true,
        createdAt: old?.createdAt || now, updatedAt: now, createdBy: old?.createdBy || actor, updatedBy: actor };
      if (!tool.title) throw new Error('请填写工具名称');
      if (old) data.tools[data.tools.indexOf(old)] = tool; else data.tools.push(tool);
      this.save(data); return tool;
    }
    if (args.action === 'related') {
      const links = data.links.filter(l => l.fromRef === args.ref || l.toRef === args.ref);
      const docs = new Map();
      for (const ref of new Set(links.flatMap(l => [l.fromRef, l.toRef]))) {
        try { docs.set(ref, await this.resolve(ref)); } catch { docs.set(ref, null); }
      }
      return { links: links.map(l => ({ ...l, stale: docs.get(l.fromRef)?.hash !== l.fromHash || docs.get(l.toRef)?.hash !== l.toHash,
        sourceMissing: !docs.get(l.fromRef) || !docs.get(l.toRef) })) };
    }
    if (args.action === 'link') {
      if (args.fromRef === args.toRef) throw new Error('请选择两个不同来源');
      const [from, to] = await Promise.all([this.resolve(args.fromRef), this.resolve(args.toRef)]);
      if (from.archived || to.archived) throw new Error('请关联未归档的内容');
      if (args.fromHash !== from.hash || args.toHash !== to.hash) throw new Error('原内容已变化，请重新读取后判断');
      const current = this.load(), old = current.links.find(l => l.fromRef === args.fromRef && l.toRef === args.toRef || l.toRef === args.fromRef && l.fromRef === args.toRef);
      if (old && actor === 'agent' && old.status !== 'suggested') return { saved: false, reason: '保留用户已有决定', link: old };
      if (old && args.version !== old.version) throw new Error('关联已修改，请重新读取');
      const reason = str(args.reason || ''); if (!reason) throw new Error('请说明关联依据');
      const now = new Date().toISOString(), status = actor === 'user' ? 'confirmed' : 'suggested';
      const link = { id: old?.id || crypto.randomUUID(), version: (old?.version || 0) + 1, fromRef: from.ref, toRef: to.ref,
        fromTitle: from.title, toTitle: to.title, fromHash: from.hash, toHash: to.hash, reason, status,
        createdAt: old?.createdAt || now, updatedAt: now, proposedBy: old?.proposedBy || actor,
        history: [...(old?.history || []), { at: now, actor, status, reason,
          runId: actor === 'agent' ? require('./run-context').currentRun(this.store)?.id || null : null }] };
      if (old) current.links[current.links.indexOf(old)] = link; else current.links.push(link);
      this.save(current); return { saved: true, link };
    }
    if (args.action === 'review') {
      if (actor !== 'user') throw new Error('Agent 可保存关联建议；确认和忽略由用户操作');
      if (!['confirmed', 'dismissed'].includes(args.status)) throw new Error('状态无效');
      const old = data.links.find(l => l.id === args.id); if (!old) throw new Error('关联不存在');
      if (args.status === 'confirmed') {
        const [from, to] = await Promise.all([this.resolve(old.fromRef), this.resolve(old.toRef)]);
        if (from.hash !== old.fromHash || to.hash !== old.toHash || from.archived || to.archived) throw new Error('原内容已变化，请重新判断关联');
      }
      const current = this.load(), link = current.links.find(l => l.id === args.id);
      if (!link || link.version !== args.version) throw new Error('关联已修改，请重新读取');
      link.status = args.status; link.version++; link.updatedAt = new Date().toISOString();
      link.history.push({ at: link.updatedAt, actor, status: args.status }); this.save(current); return link;
    }
    throw new Error('未知工具箱操作');
  }
}
module.exports = { Toolbox };
