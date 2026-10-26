const path = require('node:path');

module.exports = {
  outDir: path.resolve('out'),
  packagerConfig: {
    asar: true,
    executableName: 'AgentControlCenter',
    icon: path.resolve('assets/app.ico'),
    ignore: [/^[\\/](?:test|scripts)(?:[\\/]|$)/],
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'AgentControlCenter',
        setupExe: `Agent-Control-Center-Setup-${require('./package.json').version}.exe`,
        noMsi: true,
        setupIcon: path.resolve('assets/app.ico'),
        // 安装图标来自本地 ICO；不依赖远程 Electron 图标地址。
        nuspecTemplate: path.resolve('scripts/app.nuspectemplate'),
      },
    },
  ],
};
