const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { writeJson } = require("./store");

// Only source metadata ships with the application. Sentence text stays in data/.
const DEFAULT_SOURCE = {
  name: "A-kirami/answersbook",
  url: "https://github.com/A-kirami/answersbook",
  downloadUrl: "https://raw.githubusercontent.com/A-kirami/answersbook/master/answersbook.json",
};
const MAX_ENTRIES = 10000;
const keyOf = text => text.normalize("NFC").replace(/\s+/gu, " ").trim();
function sentence(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 600) throw new Error("每句需为 1～600 字的文字");
  return value.trim();
}
function poolOf(value) {
  if (!["general", "personal"].includes(value)) throw new Error("请选择通用句库或我的句子");
  return value;
}
function candidates(entries, pool = "mixed") {
  if (!["mixed", "general", "personal"].includes(pool)) throw new Error("抽取范围无效");
  const unique = new Map();
  // Prefer the personal attribution when the same enabled text exists in both pools.
  for (const entry of entries) {
    if (!entry.enabled || pool !== "mixed" && entry.pool !== pool) continue;
    const key = keyOf(entry.text);
    if (!unique.has(key) || entry.pool === "personal") unique.set(key, entry);
  }
  return [...unique.values()];
}
function parseImport(content, format = "text") {
  if (typeof content !== "string" || Buffer.byteLength(content) > 800000) throw new Error("导入文件请控制在 800 KB 以内");
  let rows;
  if (format === "json") {
    let parsed;
    try { parsed = JSON.parse(content.replace(/^\uFEFF/, "")); } catch { throw new Error("JSON 文件格式无法读取"); }
    rows = Array.isArray(parsed) ? parsed : parsed?.entries;
    if (!rows && parsed && typeof parsed === "object" && Object.keys(parsed).every(key => /^\d+$/.test(key))) rows = Object.values(parsed);
    if (!Array.isArray(rows)) throw new Error("JSON 需要是文字数组或包含 entries 的句库文件");
  } else if (format === "text") rows = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter(row => row.trim());
  else throw new Error("支持 TXT 或 JSON 格式");
  if (!rows.length) throw new Error("没有找到可导入的句子");
  if (rows.length > MAX_ENTRIES) throw new Error("一次最多导入 10000 句");
  return rows.map((row, index) => {
    try {
      return { text: sentence(typeof row === "string" ? row : row?.text ?? row?.answer), enabled: row?.enabled !== false };
    } catch { throw new Error(`第 ${index + 1} 条格式无效，每句需为 1～600 字的文字`); }
  });
}

class AnswerBook {
  constructor(dir) {
    this.dir = path.join(dir, "answer-book");
    this.file = path.join(this.dir, "library.json");
  }
  read() {
    // Read per operation so a separately run importer never races a cached copy.
    if (!fs.existsSync(this.file)) return { version: 1, entries: [], favorites: [], sources: [] };
    const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.entries) || !Array.isArray(data.favorites) || !Array.isArray(data.sources)) {
      throw new Error("答案之书数据格式无法读取，请保留本机文件后检查");
    }
    return data;
  }
  view() {
    const data = this.read();
    return { ...data, available: Object.fromEntries(["mixed", "general", "personal"].map(pool => [pool, candidates(data.entries, pool).length])), defaultSource: DEFAULT_SOURCE };
  }
  importRows(rows, pool, source = null) {
    poolOf(pool);
    const data = this.read(), existing = new Set(data.entries.filter(e => e.pool === pool).map(e => keyOf(e.text)));
    let added = 0, skipped = 0;
    for (const row of rows) {
      const text = sentence(row.text), key = keyOf(text);
      if (existing.has(key)) { skipped++; continue; }
      existing.add(key);
      data.entries.push({ id: crypto.randomUUID(), text, pool, enabled: row.enabled !== false,
        source: source?.name || "手动添加 / 导入", createdAt: new Date().toISOString() });
      added++;
    }
    if (data.entries.length > MAX_ENTRIES) throw new Error("两个句库合计最多保存 10000 句，请先整理后再导入");
    if (source) data.sources = [...data.sources.filter(s => s.url !== source.url), { ...source, downloadedAt: new Date().toISOString() }];
    writeJson(this.file, data);
    return { added, skipped };
  }
  async downloadDefault() {
    let bytes;
    try {
      const response = await fetch(DEFAULT_SOURCE.downloadUrl, { signal: AbortSignal.timeout(15000), redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 800000) throw new Error("来源文件过大");
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    } catch {
      // Some local proxy setups reject Node fetch while system curl succeeds.
      // The URL is fixed; no user input is passed to a shell or downloader.
      try {
        const result = await promisify(execFile)(process.platform === "win32" ? "curl.exe" : "curl",
          ["--fail", "--silent", "--show-error", "--max-time", "20", "--max-filesize", "800000", DEFAULT_SOURCE.downloadUrl],
          { windowsHide: true, encoding: "buffer", maxBuffer: 800000, timeout: 25000 });
        bytes = result.stdout;
      } catch { throw new Error("通用句库下载失败，可以从来源页面下载 JSON 后导入；已有句子保持不变"); }
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/^\s*</u.test(raw)) throw new Error("下载得到的内容不是句库文本");
    const rows = parseImport(raw, "json");
    const source = { ...DEFAULT_SOURCE, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, "downloaded-source.json"), bytes, { mode: 0o600 });
    return this.importRows(rows, "general", source);
  }
  async update(input) {
    if (input.action === "download") return this.downloadDefault();
    if (input.action === "import") return this.importRows(parseImport(input.content, input.format), poolOf(input.pool));
    if (input.action === "add") return this.importRows([{ text: sentence(input.text), enabled: true }], "personal");
    const data = this.read();
    if (input.action === "draw") {
      const eligible = candidates(data.entries, input.pool);
      if (!eligible.length) throw new Error("这个范围还没有启用的句子，可以先到句子池添加或导入");
      const entry = eligible[crypto.randomInt(eligible.length)];
      // No question, result or draw history is written until explicitly favorited.
      return { id: crypto.randomUUID(), entryId: entry.id, text: entry.text, pool: entry.pool, source: entry.source, drawnAt: new Date().toISOString() };
    }
    if (["edit", "toggle", "delete"].includes(input.action)) {
      const entry = data.entries.find(e => e.id === input.id);
      if (!entry) throw new Error("这句已不存在，请刷新句子池");
      if (input.action === "edit") {
        if (entry.pool !== "personal") throw new Error("通用句子可以停用，修改后请另存到我的句子");
        if (entry.text !== input.expectedText) throw new Error("这句已在其它页面更新，请重新读取后编辑");
        const text = sentence(input.text);
        if (data.entries.some(e => e.id !== entry.id && e.pool === "personal" && keyOf(e.text) === keyOf(text))) throw new Error("我的句子中已有相同内容");
        entry.text = text;
      } else if (input.action === "toggle") {
        if (typeof input.enabled !== "boolean") throw new Error("启用状态无效");
        entry.enabled = input.enabled;
      } else {
        if (entry.pool !== "personal") throw new Error("通用句子请使用停用功能");
        data.entries = data.entries.filter(e => e.id !== entry.id);
      }
    } else if (input.action === "favorite") {
      const result = input.result;
      if (!result || !/^[a-f0-9-]{36}$/i.test(result.id)) throw new Error("请先翻开一页再收藏");
      if (data.favorites.some(f => f.id === result.id)) return { saved: true };
      if (data.favorites.length >= 2000) throw new Error("收藏已达 2000 条，请先导出和整理");
      const question = typeof input.question === "string" ? input.question.trim() : "";
      if (question.length > 2000) throw new Error("问题最多 2000 字");
      data.favorites.push({ id: result.id, text: sentence(result.text), pool: poolOf(result.pool), question,
        source: String(result.source || "").slice(0, 200), createdAt: new Date().toISOString() });
    } else if (input.action === "unfavorite") {
      data.favorites = data.favorites.filter(f => f.id !== input.id);
    } else throw new Error("未知答案之书操作");
    writeJson(this.file, data);
    return { saved: true };
  }
}
module.exports = { AnswerBook };
