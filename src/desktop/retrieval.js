const fs = require('fs');
const path = require('path');
const { writeJson } = require('./store');
const { SearchSources, SOURCES, hash } = require('./search-sources');
const defaults = () => ({ version: 1, enabled: false, endpoint: '', model: '', apiKey: '', dimensions: null,
  chunkSize: 1600, batchSize: 8, autoIndex: true, sources: [...SOURCES] });
const signature = c => hash(JSON.stringify([c.endpoint, c.model, c.dimensions, c.chunkSize]));
function tokens(query) {
  const q = query.normalize('NFKC').toLocaleLowerCase(), result = [q];
  for (const item of new Intl.Segmenter('zh', { granularity: 'word' }).segment(q)) if (item.isWordLike) result.push(item.segment);
  for (const run of q.match(/[\p{Script=Han}]{2,}/gu) || []) for (let i = 0; i < run.length - 1; i++) result.push(run.slice(i, i + 2));
  return [...new Set(result.filter(Boolean))].slice(0, 100);
}
function chunks(docs, size) {
  return docs.flatMap(doc => {
    const content = `${doc.title}\n${doc.text}`, rows = [];
    for (let offset = 0; offset < content.length; offset += size - 150) {
      const text = content.slice(offset, offset + size);
      rows.push({ key: hash(`${doc.ref}:${offset}`), ref: doc.ref, hash: hash(text), text });
      if (offset + size >= content.length) break;
    }
    return rows;
  });
}
function unit(vector) {
  if (!Array.isArray(vector) || !vector.length || vector.length > 65536 || vector.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('向量接口返回了无效数据');
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || !norm) throw new Error('向量长度无效');
  return vector.map(x => x / norm);
}
class Retrieval {
  constructor(app, changed) {
    this.sources = new SearchSources(app); this.changed = changed;
    this.dir = path.join(app.store.dir, 'search'); this.configFile = path.join(this.dir, 'settings.json'); this.indexFile = path.join(this.dir, 'vectors.json');
    this.progress = { busy: false, done: 0, total: 0, error: '', warnings: [] }; this.paused = false;
    try { this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { this.index = { signature: '', rows: {}, updatedAt: null }; }
    if (!this.index.rows || typeof this.index.rows !== 'object') this.index = { signature: '', rows: {}, updatedAt: null };
  }
  config() { return fs.existsSync(this.configFile) ? { ...defaults(), ...JSON.parse(fs.readFileSync(this.configFile, 'utf8')) } : defaults(); }
  view() {
    const c = this.config(), { apiKey, ...publicConfig } = c;
    const chunksBySource = {};
    if (signature(c) === this.index.signature) for (const row of Object.values(this.index.rows)) {
      const source = row.ref.split(':')[0]; chunksBySource[source] = (chunksBySource[source] || 0) + 1;
    }
    return { config: { ...publicConfig, hasKey: !!apiKey }, sources: SOURCES, ...this.progress,
      chunksBySource,
      indexedChunks: signature(c) === this.index.signature ? Object.keys(this.index.rows).length : 0,
      indexCompatible: signature(c) === this.index.signature, indexedAt: this.index.updatedAt };
  }
  save(input) {
    const previous = this.config();
    const endpoint = String(input.endpoint || '').trim();
    if (endpoint) {
      const u = new URL(endpoint);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('请填写不含账户、查询参数或片段的 HTTP(S) 向量接口地址');
    }
    const c = { ...defaults(), enabled: input.enabled === true, endpoint,
      model: String(input.model || '').trim().slice(0, 200), apiKey: input.clearKey ? '' : input.apiKey ? String(input.apiKey).trim() : endpoint === previous.endpoint ? previous.apiKey : '',
      dimensions: input.dimensions ? Number(input.dimensions) : null, chunkSize: Number(input.chunkSize || 1600), batchSize: Number(input.batchSize || 8),
      autoIndex: input.autoIndex === true, sources: Array.isArray(input.sources) ? [...new Set(input.sources.filter(s => SOURCES.includes(s)))] : [...SOURCES] };
    if (c.enabled && (!c.endpoint || !c.model || !c.sources.length)) throw new Error('启用向量检索需要接口、模型和至少一个来源');
    if (c.dimensions !== null && (!Number.isInteger(c.dimensions) || c.dimensions < 1 || c.dimensions > 65536)) throw new Error('向量维度需为 1～65536 的整数或留空');
    if (!Number.isInteger(c.chunkSize) || c.chunkSize < 300 || c.chunkSize > 4000 || !Number.isInteger(c.batchSize) || c.batchSize < 1 || c.batchSize > 32) throw new Error('分段长度为 300～4000，批量为 1～32');
    if (c.apiKey.length > 8000) throw new Error('密钥过长');
    this.cancel(); writeJson(this.configFile, c); this.paused = false; this.progress.error = ''; this.changed(); return this.view();
  }
  async embed(texts, c, signal) {
    const base = c.endpoint.replace(/\/+$/, '');
    const endpoint = base.endsWith('/embeddings') ? base : `${base}/embeddings`;
    let response;
    try {
      response = await fetch(endpoint, { method: 'POST', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000),
        headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) },
        body: JSON.stringify({ model: c.model, input: texts, encoding_format: 'float', ...(c.dimensions ? { dimensions: c.dimensions } : {}) }) });
    } catch { throw new Error(signal?.aborted ? '索引更新已停止' : '向量接口连接失败或超时，请检查地址和网络'); }
    if (!response.ok) throw new Error(`向量接口返回 HTTP ${response.status}，请检查配置或额度`);
    let body; try { body = await response.json(); } catch { throw new Error('向量接口未返回 JSON'); }
    if (!Array.isArray(body.data) || body.data.length !== texts.length) throw new Error('向量接口返回数量不匹配');
    const sorted = [...body.data].sort((a, b) => a.index - b.index);
    if (sorted.some((row, i) => row.index !== i)) throw new Error('向量接口返回序号无效');
    const vectors = sorted.map(row => unit(row.embedding));
    if (vectors.some(v => v.length !== vectors[0].length) || c.dimensions && vectors[0].length !== c.dimensions) throw new Error('向量接口返回维度不一致');
    return vectors;
  }
  async test() {
    const c = this.config(); if (!c.endpoint || !c.model) throw new Error('请先保存接口和模型');
    const [vector] = await this.embed(['连接测试'], c); return { dimensions: vector.length, message: '向量接口已返回有效结果' };
  }
  cancel() { this.paused = true; this.controller?.abort(); }
  removeRefs(refs) {
    if (!refs.size) return 0;
    if (this.progress.busy) throw new Error('索引更新期间暂缓清理');
    const rows = Object.fromEntries(Object.entries(this.index.rows).filter(([, row]) => !refs.has(row.ref)));
    const removed = Object.keys(this.index.rows).length - Object.keys(rows).length;
    if (removed) { const next = { ...this.index, rows, updatedAt: new Date().toISOString() }; writeJson(this.indexFile, next); this.index = next; }
    return removed;
  }
  start(force = false, snapshot = null) {
    const c = this.config(); if (!c.enabled) throw new Error('请先启用并保存向量配置');
    if (this.progress.busy) return this.view();
    const controller = new AbortController(); this.controller = controller; this.paused = false;
    this.progress = { busy: true, done: 0, total: 0, error: '', warnings: [], startedAt: new Date().toISOString() }; this.changed();
    this.flight = this.build(c, controller.signal, force, snapshot).catch(error => {
      if (!controller.signal.aborted) this.progress.error = error.message;
      else this.progress.warnings = [...this.progress.warnings, '索引更新已停止，已保存的片段保留；可手动继续更新'];
    })
      .finally(() => { this.progress.busy = false; this.progress.finishedAt = new Date().toISOString(); this.changed(); });
    return this.view();
  }
  async build(c, signal, force, snapshot) {
    const corpus = snapshot || await this.sources.collect(c.sources);
    const rows = chunks(corpus.docs.filter(d => c.sources.includes(d.source)), c.chunkSize), sig = signature(c);
    const old = !force && this.index.signature === sig ? this.index.rows : {};
    const next = { signature: sig, rows: {}, updatedAt: null };
    this.progress.total = rows.length; this.progress.warnings = corpus.warnings;
    const pending = [];
    for (const row of rows) {
      if (old[row.key]?.hash === row.hash) { next.rows[row.key] = old[row.key]; this.progress.done++; }
      else pending.push(row);
    }
    let dimension = Object.values(next.rows)[0]?.vector?.length;
    const persist = () => {
      if (signal.aborted || signature(this.config()) !== sig) throw new Error('索引更新已停止');
      next.updatedAt = new Date().toISOString(); writeJson(this.indexFile, next); this.index = next; this.changed();
    };
    for (let i = 0; i < pending.length; i += c.batchSize) {
      if (signal.aborted) throw new Error('索引更新已停止');
      const batch = pending.slice(i, i + c.batchSize), vectors = await this.embed(batch.map(r => r.text), c, signal);
      if (dimension && dimension !== vectors[0].length) throw new Error('模型向量维度已改变，请重建索引');
      dimension = vectors[0].length;
      batch.forEach((row, n) => { next.rows[row.key] = { ref: row.ref, hash: row.hash, vector: vectors[n] }; });
      this.progress.done += batch.length; persist();
    }
    persist();
  }
  async search(args) {
    const query = String(args.query || '').trim(); if (!query || query.length > 2000) throw new Error('请输入 1～2000 字的检索内容');
    const selected = args.sources?.length ? args.sources.filter(s => SOURCES.includes(s)) : SOURCES;
    const corpus = await this.sources.collect(selected), docs = corpus.docs.filter(d => args.includeArchived || !d.archived), c = this.config();
    const words = tokens(query), lexical = [], scores = new Map(), details = new Map();
    for (const doc of docs) {
      const body = doc.text.normalize('NFKC').toLocaleLowerCase(), title = doc.title.normalize('NFKC').toLocaleLowerCase();
      const matched = words.filter(word => body.includes(word) || title.includes(word));
      const score = matched.reduce((sum, word) => sum + Math.min(8, word.length) * (title.includes(word) ? 5 : 1), 0);
      if (score) { lexical.push({ ref: doc.ref, score }); details.set(doc.ref, { matchedTerms: matched.slice(0, 10) }); }
    }
    lexical.sort((a, b) => b.score - a.score); lexical.forEach((r, i) => scores.set(r.ref, 1 / (60 + i)));
    const warnings = [...corpus.warnings]; let mode = 'keyword', pendingChunks = 0;
    if (c.enabled && args.mode !== 'keyword') {
      const vectorRows = chunks(docs.filter(d => c.sources.includes(d.source)), c.chunkSize), sig = signature(c);
      const index = this.index;
      const eligible = vectorRows.filter(r => index.signature === sig && index.rows[r.key]?.hash === r.hash);
      pendingChunks = vectorRows.length - eligible.length;
      if (pendingChunks && c.autoIndex && !this.progress.busy && !this.progress.error && !this.paused) this.start(false);
      if (eligible.length) {
        try {
          const [queryVector] = await this.embed([query], c), best = new Map();
          for (const row of eligible) {
            const vector = index.rows[row.key]?.vector;
            if (!vector || vector.length !== queryVector.length) throw new Error('索引维度与模型不一致，请重建索引');
            const similarity = vector.reduce((sum, x, i) => sum + x * queryVector[i], 0);
            if (similarity > 0 && (!best.has(row.ref) || best.get(row.ref).similarity < similarity)) best.set(row.ref, { similarity, text: row.text });
          }
          [...best].sort((a, b) => b[1].similarity - a[1].similarity).forEach(([ref, detail], i) => {
            scores.set(ref, (scores.get(ref) || 0) + 1 / (60 + i)); details.set(ref, { ...details.get(ref), ...detail });
          }); mode = 'hybrid';
        } catch (error) { warnings.push(`${error.message}；本次返回关键词结果`); }
      }
      if (pendingChunks) warnings.push(`${pendingChunks} 个内容片段待向量化${this.progress.busy ? '，后台正在更新' : '，可在设置页更新索引'}`);
      if (this.progress.error) warnings.push(this.progress.error);
    }
    const byRef = new Map(docs.map(d => [d.ref, d]));
    const ranked = [...scores].sort((a, b) => b[1] - a[1]);
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0)), limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit) || 15)));
    const items = ranked.slice(offset, offset + limit).map(([ref, score]) => {
      const { text, ...doc } = byRef.get(ref), detail = details.get(ref) || {};
      const position = detail.matchedTerms?.map(t => text.toLocaleLowerCase().indexOf(t)).find(i => i >= 0) ?? 0;
      return { ...doc, score, matchedTerms: detail.matchedTerms || [], similarity: detail.similarity,
        snippet: (detail.text || text.slice(Math.max(0, position - 100))).slice(0, 650) };
    });
    return { items, total: ranked.length, nextOffset: offset + limit < ranked.length ? offset + limit : null, mode, warnings, collectedAt: corpus.collectedAt };
  }
  async invoke(args) {
    if (args.action === 'search') return this.search(args);
    if (args.action === 'read') {
      const doc = await this.sources.read(args.ref), offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      return { ...doc, text: doc.text.slice(offset, offset + 16000), totalLength: doc.text.length, nextOffset: offset + 16000 < doc.text.length ? offset + 16000 : null };
    }
    if (args.action === 'status') return { sources: SOURCES, enabled: this.config().enabled, ...this.progress, indexedAt: this.index.updatedAt };
    throw new Error('未知检索操作');
  }
}
module.exports = { Retrieval };
