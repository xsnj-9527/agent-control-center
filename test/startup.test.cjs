const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const source = readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const mainRequire = createRequire(path.join(__dirname, '../electron/main.cjs'));

function loadStartup(squirrelStartup, startupError) {
  const state = { readyCalls: 0, protocolCalls: 0, quitCalls: 0, errors: [] };
  const electron = {
    app: {
      setAppUserModelId() {},
      whenReady() {
        state.readyCalls += 1;
        return startupError ? Promise.reject(startupError) : new Promise(() => {});
      },
      on() {},
      quit() { state.quitCalls += 1; },
    },
    protocol: { registerSchemesAsPrivileged() { state.protocolCalls += 1; } },
    dialog: { showErrorBox(title, message) { state.errors.push({ title, message }); } },
  };
  state.validateSender = new Function('require', `${source}\nreturn validateSender;`)((id) => {
    if (id === 'electron') return electron;
    if (id === 'electron-squirrel-startup') return squirrelStartup;
    return mainRequire(id);
  });
  return state;
}

test('安装器生命周期事件不会初始化桌面窗口或资源协议', () => {
  const state = loadStartup(true);
  assert.equal(state.readyCalls, 0);
  assert.equal(state.protocolCalls, 0);
});

test('正常启动会等待 Electron 就绪并注册本地协议', () => {
  const state = loadStartup(false);
  assert.equal(state.readyCalls, 1);
  assert.equal(state.protocolCalls, 1);
});

test('启动失败时显示具体原因并退出', async () => {
  const state = loadStartup(false, new Error('无法加载本地页面'));
  await new Promise(setImmediate);
  assert.deepEqual(state.errors, [{ title: 'Agent Control Center 启动失败', message: '无法加载本地页面' }]);
  assert.equal(state.quitCalls, 1);
});

test('本地数据 IPC 拒绝其他源和子框架', () => {
  const { validateSender } = loadStartup(false);
  const frame = { url: 'app://control-center/index.html#history' };
  assert.doesNotThrow(() => validateSender({ senderFrame: frame, sender: { mainFrame: frame } }));
  const foreign = { url: 'https://example.com/index.html' };
  assert.throws(() => validateSender({ senderFrame: foreign, sender: { mainFrame: foreign } }), /拒绝/);
  assert.throws(() => validateSender({ senderFrame: frame, sender: { mainFrame: {} } }), /拒绝/);
});

test('生产包排除自有测试和构建脚本，同时保留运行代码', () => {
  const { packagerConfig } = require('../forge.config.js');
  const excluded = (file) => packagerConfig.ignore.some((rule) => rule.test(file));
  assert.equal(excluded('/test/fixture.cjs'), true);
  assert.equal(excluded('\\test\\fixture.cjs'), true);
  assert.equal(excluded('/scripts/make-windows.cjs'), true);
  assert.equal(excluded('/electron/preload.cjs'), false);
  assert.equal(excluded('/src/main.js'), false);
});

test('Squirrel 安装图标写入自身安装目录，开发和便携目录不写入', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const { installIcon } = require('../electron/install-icon.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-icon-'));
  try {
    const appRoot = path.join(root, 'app-0.3.2');
    await fs.mkdir(path.join(appRoot, 'assets'), { recursive: true });
    const sourceIcon = path.join(__dirname, '../assets/app.ico');
    await fs.copyFile(sourceIcon, path.join(appRoot, 'assets/app.ico'));
    const options = { appRoot, isPackaged: true, executable: path.join(appRoot, 'AgentControlCenter.exe'), platform: 'win32' };
    assert.equal(installIcon(options), false);
    await fs.writeFile(path.join(root, 'Update.exe'), 'fixture');
    assert.equal(installIcon({ ...options, isPackaged: false }), false);
    assert.equal(installIcon({ ...options, executable: path.join(root, 'portable/AgentControlCenter.exe') }), false);
    assert.equal(installIcon(options), true);
    assert.deepEqual(await fs.readFile(path.join(root, 'app.ico')), await fs.readFile(sourceIcon));
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('acc-icon-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
