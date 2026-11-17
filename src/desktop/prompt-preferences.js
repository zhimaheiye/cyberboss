const fs = require('fs');
const path = require('path');
const { hash } = require('./search-sources');
class PromptPreferences {
  constructor(store) { this.store = store; }
  view() {
    const defaults = fs.readFileSync(path.resolve(__dirname, '../../templates/desktop-instructions.md'), 'utf8');
    const data = this.store.data.promptPreferences || { version: 0, versions: [] };
    return { ...data, text: data.versions.at(-1)?.text || '', defaultVersion: hash(defaults).slice(0, 12), defaults,
      defaultChanged: !!data.versions.length && data.versions.at(-1).defaultVersion !== hash(defaults).slice(0, 12) };
  }
  save(input) {
    const old = this.view();
    if (Number(input.version) !== old.version) throw new Error('偏好已变化，请重新打开编辑');
    const text = String(input.text || '').trim();
    if (text.length > 16000) throw new Error('个人偏好最多 16000 字');
    const version = { version: old.version + 1, text, createdAt: new Date().toISOString(), actor: 'user',
      defaultVersion: old.defaultVersion, defaultText: old.defaults };
    this.store.data.promptPreferences = { version: version.version, versions: [...old.versions, version] };
    this.store.save(); return this.view();
  }
}
module.exports = { PromptPreferences };
