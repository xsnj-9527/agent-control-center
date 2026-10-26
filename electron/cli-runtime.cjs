const { access, readdir, realpath, readFile, mkdir, writeFile } = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

async function exists(file) { try { await access(file, constants.R_OK); return await realpath(file); } catch { return null; } }
async function discover(overrides = {}) {
  const paths = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const npm = path.join(process.env.APPDATA || os.homedir(), 'npm', 'node_modules');
  const result = {};
  for (const agent of ['codex', 'opencode', 'claude', 'dsh']) {
    const candidates = [];
    if (overrides[agent]) candidates.push(overrides[agent]);
    candidates.push(...paths.map((directory) => path.join(directory, `${agent}.exe`)));
    if (agent === 'opencode') candidates.push(path.join(npm, '@opencode/cli/bin/opencode.exe'));
    if (agent === 'claude') candidates.push(path.join(npm, '@anthropic-ai/claude-code/bin/claude.exe'));
    if (agent === 'dsh') candidates.push(path.join(npm, '@deepseek-ai/dsh/lib/bin.js'));
    if (agent === 'codex') {
      const base = path.join(process.env.LOCALAPPDATA || os.homedir(), 'OpenAI/Codex/bin');
      try { for (const dir of await readdir(base, { withFileTypes: true })) if (dir.isDirectory()) candidates.push(path.join(base, dir.name, 'codex.exe')); } catch {}
    }
    let file;
    for (const candidate of candidates) { file = await exists(candidate); if (file) break; }
    let command = file, prefix = [];
    if (file?.endsWith('.js')) {
      command = null;
      for (const directory of paths) { command = await exists(path.join(directory, 'node.exe')); if (command) break; }
      if (command) prefix = [file];
    }
    result[agent] = { available: Boolean(command), command, prefix, file, version: '' };
    if (command) result[agent].version = await version(command, prefix);
  }
  return result;
}
function version(command, prefix) {
  return new Promise((resolve) => {
    const child = spawn(command, [...prefix, '--version'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const timer = setTimeout(() => { child.kill(); resolve('版本检测超时'); }, 4000);
    child.stdout.on('data', (data) => { text += data; });
    child.on('error', () => { clearTimeout(timer); resolve('无法启动'); });
    child.on('close', () => { clearTimeout(timer); resolve(text.trim().slice(0, 120)); });
  });
}
async function dshPatch(runtime, directory) {
  await mkdir(directory, { recursive: true });
  const bridge = path.join(directory, 'acc-dsh-bridge.mjs');
  await writeFile(bridge, await readFile(path.join(__dirname, 'dsh-bridge.mjs')));
  const patch = path.join(directory, 'acc-dsh.patch.yml');
  await writeFile(patch, `- id: headless-startup\n  disabled: true\n- id: headless-runner\n  disabled: true\n- insert:\n    - id: acc-runner\n      name: ${JSON.stringify(pathToFileURL(bridge).href)}\n`);
  return { patch, packageFile: path.join(path.dirname(path.dirname(runtime.file)), 'package.json') };
}
module.exports = { discover, dshPatch };
