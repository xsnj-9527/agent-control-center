const assert = require('node:assert/strict');
const { existsSync, statSync, mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

if (process.platform !== 'win32') throw new Error('请在 Windows 上生成安装包。');

const projectRoot = path.resolve(__dirname, '..');
const [drive, temporaryDrive] = [...'ZYXWVUTSRQPONMLK'].map((letter) => `${letter}:`).filter((letter) => !existsSync(`${letter}\\`));
if (!temporaryDrive) throw new Error('打包需要两个空闲盘符，分别映射项目和资源工具临时目录。');
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'acc-build-'));
let temporaryMapped = false;

// 映射父目录并保留项目子目录，避免打包器在盘符根目录下跳过开发依赖裁剪。
execFileSync('subst.exe', [drive, path.dirname(projectRoot)]);
try {
  // 安装器会复制应用到系统临时目录；旧版 rcedit 同样要求该路径不含中文。
  execFileSync('subst.exe', [temporaryDrive, temporaryRoot]);
  temporaryMapped = true;
  const aliasRoot = path.join(`${drive}\\`, path.basename(projectRoot));
  assert.notEqual(aliasRoot, path.parse(aliasRoot).root);
  assert.equal(statSync(aliasRoot, { bigint: true }).ino, statSync(projectRoot, { bigint: true }).ino);
  assert.equal(statSync(`${temporaryDrive}\\`, { bigint: true }).ino, statSync(temporaryRoot, { bigint: true }).ino);
  const cli = path.join(projectRoot, 'node_modules/@electron-forge/cli/dist/electron-forge.js');
  const result = spawnSync(process.execPath, [cli, 'make'], { cwd: aliasRoot, stdio: 'inherit', env: { ...process.env, TEMP: `${temporaryDrive}\\`, TMP: `${temporaryDrive}\\` } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (temporaryMapped) execFileSync('subst.exe', [temporaryDrive, '/D']);
  execFileSync('subst.exe', [drive, '/D']);
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith('acc-build-'));
  rmSync(temporaryRoot, { recursive: true, force: true });
}
