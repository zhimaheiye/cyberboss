const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

// Inspect only extension installation metadata, never cookies or browser storage.
// Launching an existing profile is allowed; changing its preferences is not.
async function inspectBrowserHost(extensionId) {
  if (process.platform !== 'win32') return { supported: false, note: '请使用本机工具检查浏览器进程与扩展界面' };
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], local].filter(Boolean);
  const installations = [
    { browser: 'Edge', relative: 'Microsoft/Edge', processName: 'msedge.exe' },
    { browser: 'Chrome', relative: 'Google/Chrome', processName: 'chrome.exe' },
  ];
  const profiles = [];
  for (const entry of installations) {
    const userData = path.join(local, entry.relative, 'User Data');
    if (!fs.existsSync(userData)) continue;
    const executable = roots.map(root => path.join(root, entry.relative, 'Application', entry.processName)).find(file => fs.existsSync(file));
    for (const dir of fs.readdirSync(userData, { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^(Default|Profile \d+)$/.test(dir.name)) continue;
      const extensions = path.join(userData, dir.name, 'Extensions');
      if (!fs.existsSync(extensions)) continue;
      for (const id of fs.readdirSync(extensions)) {
        if (!/^[a-p]{32}$/.test(id) || extensionId && id !== extensionId) continue;
        const folder = path.join(extensions, id);
        if (!fs.statSync(folder).isDirectory()) continue;
        for (const version of fs.readdirSync(folder).reverse()) {
          const manifest = path.join(folder, version, 'manifest.json');
          if (!fs.existsSync(manifest)) continue;
          let data; try { data = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch { continue; }
          if (!extensionId && !/kimi/i.test(`${data.name} ${data.description}`)) continue;
          profiles.push({ browser: entry.browser, profile: dir.name, userData, executable,
            processName: entry.processName, extensionId: id, version: data.version,
            enabled: 'unknown', note: '安装文件存在不代表扩展已启用；断连也不代表被禁用' });
          break;
        }
      }
    }
  }
  const running = await new Promise((resolve, reject) => execFile('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-Process -Name msedge,chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique; exit 0",
  ], { windowsHide: true, timeout: 10000, maxBuffer: 65536 }, (error, stdout) => error ? reject(error) : resolve(stdout.toLowerCase().split(/\s+/).filter(Boolean))));
  return { supported: true, profiles: profiles.map(profile => ({ ...profile,
    browserRunning: running.includes(profile.processName.replace('.exe', '')) })), running };
}

async function launchBrowserProfile(profile) {
  if (!profile.executable || !fs.existsSync(profile.executable)) throw new Error('没有找到此配置对应的浏览器程序');
  // Do not kill/restart the browser, disable security, install an extension, or
  // select a different account. Chromium reuses its existing profile process.
  await new Promise((resolve, reject) => {
    const child = spawn(profile.executable, [`--user-data-dir=${profile.userData}`,
      `--profile-directory=${profile.profile}`, 'about:blank'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}

module.exports = { inspectBrowserHost, launchBrowserProfile };
