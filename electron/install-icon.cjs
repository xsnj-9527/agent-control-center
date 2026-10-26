const { copyFileSync, existsSync } = require('node:fs');
const path = require('node:path');

function installIcon({ appRoot, isPackaged, executable = process.execPath, platform = process.platform }) {
  if (!isPackaged || platform !== 'win32') return false;
  const versionDirectory = path.dirname(executable);
  const installRoot = path.dirname(versionDirectory);
  if (!/^app-\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/.test(path.basename(versionDirectory)) || !existsSync(path.join(installRoot, 'Update.exe'))) return false;
  // Squirrel 的卸载项引用根目录 app.ico，本地图标无需从远程地址下载。
  copyFileSync(path.join(appRoot, 'assets', 'app.ico'), path.join(installRoot, 'app.ico'));
  return true;
}

module.exports = { installIcon };
