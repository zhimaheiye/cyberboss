const fs = require('fs');
const path = require('path');
const { writeJson } = require('./store');

const initial = () => ({ version: 1, revision: 0, scenarios: [{ id: 'next-step', title: '从一件事开始',
  description: '一个可以自由修改的分支示例。', entry: 'start', nodes: [
    { id: 'start', type: 'question', text: '现在有想做的事吗？', options: [
      { label: '已经有了', next: 'ready' }, { label: '还没想好', next: 'choose' }] },
    { id: 'ready', type: 'result', text: '写下这件事的第一个小步骤。', detail: '可以把它加入待办，或带到对话里继续整理。' },
    { id: 'choose', type: 'result', text: '看看现有待办，挑一件此刻想做的事。', detail: '也可以先休息，稍后再回来。' },
  ] }] });

function validate(scenarios) {
  if (!Array.isArray(scenarios) || !scenarios.length || scenarios.length > 30) throw new Error('请保留 1～30 个场景');
  const text = (value, max, required = false) => {
    if (typeof value !== 'string' || value.length > max || required && !value.trim()) throw new Error('文字为空或过长，请检查标题、问题和选项');
    return value;
  };
  const id = value => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('分支标识无效');
    return value;
  };
  const sceneIds = new Set();
  return scenarios.map(scene => {
    if (sceneIds.has(id(scene.id))) throw new Error('场景标识重复');
    sceneIds.add(scene.id);
    if (!Array.isArray(scene.nodes) || !scene.nodes.length || scene.nodes.length > 100) throw new Error('每个场景需要 1～100 个节点');
    const nodes = scene.nodes.map(node => {
      const base = { id: id(node.id), type: node.type, text: text(node.text, 6000, true), detail: text(node.detail || '', 12000) };
      if (node.type === 'result') return base;
      if (node.type !== 'question' || !Array.isArray(node.options) || !node.options.length || node.options.length > 12) throw new Error('每个问题需要 1～12 个选项');
      return { ...base, options: node.options.map(option => ({ label: text(option.label, 300, true), next: id(option.next) })) };
    });
    const map = new Map(nodes.map(node => [node.id, node]));
    if (map.size !== nodes.length || !map.has(scene.entry)) throw new Error('节点重复或入口不存在');
    const visited = new Set(), visiting = new Set();
    function walk(nodeId) {
      if (visiting.has(nodeId)) throw new Error('分支形成了循环，请将选项连接到后续问题或结果');
      if (visited.has(nodeId)) return;
      const node = map.get(nodeId);
      if (!node) throw new Error('有选项指向不存在的节点，请重新选择跳转目标');
      visiting.add(nodeId);
      for (const option of node.options || []) walk(option.next);
      visiting.delete(nodeId); visited.add(nodeId);
    }
    for (const node of nodes) walk(node.id);
    return { id: scene.id, title: text(scene.title, 120, true), description: text(scene.description || '', 600), entry: scene.entry, nodes };
  });
}

class DecisionGuide {
  constructor(dir) {
    this.dir = path.join(dir, 'decision-guide');
    this.file = path.join(this.dir, 'guide.json');
    this.sources = path.join(this.dir, 'sources');
  }
  read() {
    if (!fs.existsSync(this.file)) return initial();
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (data.version !== 1 || !Number.isInteger(data.revision) || data.revision < 0) throw new Error('分支文件版本不支持，原文件已保留');
    return { ...data, scenarios: validate(data.scenarios) };
  }
  references() {
    return fs.existsSync(this.sources) ? fs.readdirSync(this.sources).filter(name => /\.(md|txt)$/.test(name)).map(name => ({ name, title: name.replace(/\.(md|txt)$/, '') })) : [];
  }
  reference(name) {
    if (!this.references().some(item => item.name === name)) throw new Error('未找到这份参考笔记');
    return { name, text: fs.readFileSync(path.join(this.sources, name), 'utf8') };
  }
  view() { return { ...this.read(), references: this.references() }; }
  save({ revision, scenarios }) {
    const current = this.read();
    if (revision !== current.revision) throw new Error('分支已在其他页面修改；请保留当前草稿，重新打开页面后合并');
    const next = { version: 1, revision: current.revision + 1, scenarios: validate(scenarios) };
    if (fs.existsSync(this.file)) writeJson(path.join(this.dir, 'guide.previous.json'), current);
    writeJson(this.file, next);
    return this.view();
  }
}
module.exports = { DecisionGuide };
