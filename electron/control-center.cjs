const { readFile, writeFile, mkdir, rename, stat } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { AGENTS, createAgentReader, deduplicate } = require('./agent-readers.cjs');
const { createCodexReader } = require('./codex-reader.cjs');
const { createLedger } = require('./ledger.cjs');
const { discover } = require('./cli-runtime.cjs');
const { createTaskManager } = require('./task-manager.cjs');

async function createControlCenter({ directory, notify }) {
  await mkdir(directory, { recursive: true });
  const settingsFile = path.join(directory, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(settingsFile, 'utf8')); } catch {}
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  if (settings.homes) settings.homes = Object.fromEntries(Object.entries(settings.homes).filter(([agent, value]) => Object.hasOwn(AGENTS, agent) && typeof value === 'string' && path.isAbsolute(value)));
  if (typeof settings.codexHome !== 'string' || !path.isAbsolute(settings.codexHome)) delete settings.codexHome;
  const home = os.homedir();
  const homes = { codex: settings.homes?.codex || settings.codexHome || process.env.CODEX_HOME || path.join(home, '.codex'), opencode: settings.homes?.opencode || path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode'), claude: settings.homes?.claude || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), dsh: settings.homes?.dsh || process.env.DSH_HOME || path.join(home, '.dsh') };
  const makeReader = (agent) => agent === 'codex' ? createCodexReader(homes[agent]) : createAgentReader(agent, homes[agent]);
  const readers = Object.fromEntries(Object.keys(AGENTS).map((agent) => [agent, makeReader(agent)]));
  const runtimes = await discover(settings.executables);
  const ledger = createLedger(path.join(directory, 'control.sqlite'));
  const manager = createTaskManager({ ledger, runtimes, homes, runtimeDir: path.join(directory, 'runtime'), onChange: notify });
  let records = [], pending;
  async function saveSettings() {
    await writeFile(`${settingsFile}.tmp`, JSON.stringify({ ...settings, homes }, null, 2));
    await rename(`${settingsFile}.tmp`, settingsFile);
  }
  async function readOverview() {
    const now = Date.now();
    const results = await Promise.all(Object.keys(AGENTS).map(async (agent) => ({ agent, ...await readers[agent].overview() })));
    records = deduplicate(results.flatMap((result) => result.records || []));
    const sessions = results.flatMap((result) => result.sessions.map((session) => ({ ...session, agent: result.agent }))).sort((a, b) => b.updatedAt - a.updatedAt);
    const dayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
    const days = Array.from({ length: 7 }, (_, index) => ({ date: dayFormatter.format(now - (6 - index) * 86400000), tokens: 0, calls: 0 }));
    const usage = { available: records.length > 0, totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, calls: 0, days, models: [], scannedSessions: sessions.length, totalSessions: results.reduce((n, r) => n + r.totalSessions, 0), partialFiles: results.reduce((n, r) => n + (r.usage?.partialFiles || r.partialFiles || 0), 0) };
    const models = new Map();
    for (const record of records) {
      if (!Number.isFinite(record.timestamp) || record.timestamp > now) continue;
      const day = days.find((d) => d.date === dayFormatter.format(record.timestamp));
      if (!day) continue;
      day.tokens += record.total; day.calls++;
      usage.totalTokens += record.total; usage.inputTokens += record.input; usage.cachedInputTokens += record.cached; usage.outputTokens += record.output; usage.calls++;
      const key = `${record.agent}:${record.provider}:${record.model}`;
      const model = models.get(key) || { agent: record.agent, provider: record.provider, model: record.model, tokens: 0, calls: 0 };
      model.tokens += record.total; model.calls++; models.set(key, model);
    }
    usage.models = [...models.values()].sort((a, b) => b.tokens - a.tokens);
    return { capturedAt: now, sessions, totalSessions: usage.totalSessions, usage, agents: results.map((result) => ({ id: result.agent, name: AGENTS[result.agent], connection: result.connection, count: result.totalSessions, scanned: result.sessions.length, runtime: runtimes[result.agent] })), jobs: manager.jobs(), billingSummary: ledger.billing(records).totals };
  }
  function overview() { if (!pending) pending = readOverview().finally(() => { pending = undefined; }); return pending; }
  return {
    overview, manager, ledger, homes, runtimes,
    async details(agent, id) { if (!Object.hasOwn(AGENTS, agent) || typeof id !== 'string' || id.length > 200) throw new Error('无效会话。'); return { ...await readers[agent].details(id), agent }; },
    async setHome(agent, directory) {
      if (!Object.hasOwn(AGENTS, agent) || !path.isAbsolute(directory)) throw new Error('目录无效。');
      if (manager.activeCount()) throw new Error('请先结束受控任务，再修改接入目录。');
      const reader = agent === 'codex' ? createCodexReader(directory) : createAgentReader(agent, directory);
      const result = await reader.overview();
      if (result.connection.status !== 'connected') throw new Error(result.connection.message);
      homes[agent] = directory; readers[agent] = reader; await saveSettings(); return overview();
    },
    async setExecutable(agent, file) {
      if (!Object.hasOwn(AGENTS, agent) || !path.isAbsolute(file) || !(await stat(file)).isFile() || !(agent === 'dsh' ? /\.(exe|js)$/i : /\.exe$/i).test(file)) throw new Error('请选择有效的 Agent 可执行文件。');
      if (manager.activeCount()) throw new Error('请先结束受控任务，再修改 CLI。');
      const next = await discover({ ...(settings.executables || {}), [agent]: file });
      if (!next[agent].available || !next[agent].version || next[agent].version === '无法启动') throw new Error('所选 CLI 无法启动。');
      settings.executables = { ...(settings.executables || {}), [agent]: file }; Object.assign(runtimes, next); await saveSettings(); return overview();
    },
    async billing(filter) { if (!records.length) await overview(); return ledger.billing(records, filter); },
  };
}
module.exports = { createControlCenter };
