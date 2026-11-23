const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installation } = require('../src/desktop/moraine');

const { dir, python } = installation();
const revision = 'aefce6df8fdcd98e3d541252ecf8ba53629142ec'; // v0.3.0-beta.17
function uv(args) {
  const result = spawnSync('uv', args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(python)) uv(['venv', '--python', '3.12', path.join(dir, 'venv')]);
// The beta HTTP store uses the standard library. Only the optional vector
// server imports fastembed; this integration runs the beta and MCP servers.
uv(['pip', 'install', '--python', python, 'mcp>=1,<2']);
uv(['pip', 'install', '--no-deps', '--python', python, `moraine-home @ git+https://github.com/ceniran/moraine-home.git@${revision}`]);
