const { app, BrowserWindow, protocol, dialog, ipcMain } = require('electron');
const squirrelStartup = require('electron-squirrel-startup');
const { readFile, writeFile, stat } = require('node:fs/promises');
const path = require('node:path');
const { createControlCenter } = require('./control-center.cjs');
const { AGENTS } = require('./agent-readers.cjs');
const { installIcon } = require('./install-icon.cjs');

if (app.isPackaged) {
  try { installIcon({ appRoot: app.getAppPath(), isPackaged: true }); }
  catch (error) { console.error('无法更新安装图标：', error.message); }
}

let center;
let quitApproved = false;
let quitPending = false;

function validateSender(event) {
  const url = new URL(event.senderFrame?.url || 'about:blank');
  if (event.senderFrame !== event.sender.mainFrame || url.protocol !== 'app:' || url.host !== 'control-center' || url.pathname !== '/index.html') {
    throw new Error('拒绝非应用页面的数据请求。');
  }
}

async function connectLocalData() {
  let eventTimer;
  center = await createControlCenter({ directory: app.getPath('userData'), notify() {
    if (!eventTimer) eventTimer = setTimeout(() => { eventTimer = null; for (const window of BrowserWindow.getAllWindows()) window.webContents.send('control:changed'); }, 150);
  } });
  const handle = (channel, callback) => ipcMain.handle(`control:${channel}`, (event, ...args) => { validateSender(event); return callback(event, ...args); });
  const owner = (event) => BrowserWindow.fromWebContents(event.sender);
  handle('overview', () => center.overview());
  handle('details', (_, agent, id) => center.details(agent, id));
  handle('jobs', () => center.manager.jobs());
  handle('logs', (_, id) => { if (typeof id !== 'string' || !center.manager.jobs().some((job) => job.id === id)) throw new Error('任务不存在。'); return center.ledger.logs(id); });
  handle('cancel', (_, id) => center.manager.cancel(id));
  handle('approve', (_, job, id, allow) => center.manager.approve(job, id, allow));
  handle('respond', (_, job, id, answers) => center.manager.approve(job, id, true, answers));
  handle('start', async (event, input) => {
    if (!input || !Object.hasOwn(AGENTS, input.agent) || typeof input.workspace !== 'string' || typeof input.prompt !== 'string' || input.prompt.length > 32000) throw new Error('任务参数无效。');
    const result = await dialog.showMessageBox(owner(event), { type: 'question', title: '启动 Agent 任务', message: `使用 ${AGENTS[input.agent]} 执行任务？`, detail: `工作区：${input.workspace}\n\n${input.prompt.slice(0, 500)}\n\nAgent 将使用已有登录和项目配置，可能修改文件并产生模型费用。需要审批的操作会在任务中显示。`, buttons: ['取消', '启动任务'], defaultId: 0, cancelId: 0 });
    return result.response === 1 ? center.manager.start(input) : null;
  });
  handle('workspace', async (event) => { const result = await dialog.showOpenDialog(owner(event), { title: '选择任务工作区', properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
  handle('choose-home', async (event, agent) => {
    if (!Object.hasOwn(AGENTS, agent)) throw new Error('Agent 无效。');
    const result = await dialog.showOpenDialog(owner(event), { title: `选择 ${AGENTS[agent]} 数据目录`, properties: ['openDirectory'] });
    return result.canceled ? null : center.setHome(agent, result.filePaths[0]);
  });
  handle('choose-cli', async (event, agent) => {
    if (!Object.hasOwn(AGENTS, agent)) throw new Error('Agent 无效。');
    const result = await dialog.showOpenDialog(owner(event), { title: `选择 ${AGENTS[agent]} CLI`, properties: ['openFile'], filters: [{ name: 'CLI', extensions: agent === 'dsh' ? ['exe', 'js'] : ['exe'] }] });
    return result.canceled ? null : center.setExecutable(agent, result.filePaths[0]);
  });
  handle('billing', (_, filter) => center.billing(filter));
  handle('save-rate', (_, rate) => center.ledger.saveRate(rate));
  handle('delete-rate', (_, rate) => center.ledger.deleteRate(rate));
  handle('import-bill', async (event) => {
    const result = await dialog.showOpenDialog(owner(event), { title: '导入账单 CSV', properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (result.canceled) return null;
    if ((await stat(result.filePaths[0])).size > 5 * 1024 * 1024) throw new Error('CSV 最大 5 MB。');
    return center.ledger.importCsv(await readFile(result.filePaths[0], 'utf8'));
  });
  handle('remove-bill', async (event, id) => {
    const result = await dialog.showMessageBox(owner(event), { type: 'question', message: '删除此条导入账单？', detail: '只删除控制中心的导入记录。', buttons: ['保留', '删除'], defaultId: 0, cancelId: 0 });
    if (result.response === 1) center.ledger.removeInvoice(id);
  });
  handle('export-bill', async (event, filter) => {
    const billing = await center.billing(filter);
    const result = await dialog.showSaveDialog(owner(event), { title: '导出本地成本台账', defaultPath: `Agent-Control-Center-${billing.month}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (result.canceled) return null;
    await writeFile(result.filePath, center.ledger.exportCsv(billing), 'utf8'); return result.filePath;
  });
}

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/src/main.js': ['src/main.js', 'text/javascript; charset=utf-8'],
  '/src/style.css': ['src/style.css', 'text/css; charset=utf-8'],
  '/assets/app.png': ['assets/app.png', 'image/png'],
};

async function createWindow() {
  const appRoot = app.getAppPath();
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const entry = url.host === 'control-center' && Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
    const [relativePath, contentType] = entry ?? [];
    if (!relativePath) return new Response('Not found', { status: 404 });
    return new Response(await readFile(path.join(appRoot, relativePath)), { headers: { 'content-type': contentType } });
  });

  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#111317',
    title: 'Agent Control Center',
    icon: path.join(appRoot, 'assets/app.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    const url = new URL(target);
    if (url.protocol !== 'app:' || url.host !== 'control-center') event.preventDefault();
  });
  window.on('close', (event) => {
    if (center?.manager.activeCount() && !quitApproved) { event.preventDefault(); requestQuit(); }
  });
  await window.loadURL('app://control-center/index.html');
}

// 安装器会为安装、更新和卸载启动额外进程，这些进程不创建应用窗口。
const ownsInstance = squirrelStartup ? false : (app.requestSingleInstanceLock?.() ?? true);
if (!squirrelStartup && ownsInstance) {
  app.setAppUserModelId('com.squirrel.AgentControlCenter.AgentControlCenter');
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
  app.whenReady().then(async () => { await connectLocalData(); await createWindow(); }).catch((error) => {
    dialog.showErrorBox('Agent Control Center 启动失败', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (center?.manager.activeCount() && !quitApproved) { event.preventDefault(); requestQuit(); }
  });
  app.on('second-instance', () => { const window = BrowserWindow.getAllWindows()[0]; if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('will-quit', () => center?.ledger.close());
}
else if (!squirrelStartup) app.quit();

async function requestQuit() {
  if (quitPending) return;
  quitPending = true;
  try {
    const result = await dialog.showMessageBox({ type: 'warning', title: '任务仍在运行', message: '取消所有受控任务并退出？', detail: '退出会中断控制中心启动的任务。已产生的文件修改会保留。', buttons: ['继续运行', '取消任务并退出'], defaultId: 0, cancelId: 0 });
    if (result.response === 1) { await center.manager.stopAll(); quitApproved = true; app.quit(); }
  } catch (error) { dialog.showErrorBox('无法退出', error.message); }
  finally { quitPending = false; }
}
