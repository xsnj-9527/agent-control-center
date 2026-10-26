const { DatabaseSync } = require('node:sqlite');
const { readdir, realpath, lstat } = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createInterface } = require('node:readline');
const path = require('node:path');

const SESSION_LIMIT = 200;
const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
const TIME_ZONE = 'Asia/Shanghai';
const dayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validTokens(usage) {
  return usage && ['input_tokens', 'output_tokens', 'total_tokens'].every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0);
}

function createCodexReader(home) {
  const cache = new Map();
  let pending;

  async function openIndex() {
    const root = await realpath(home);
    const files = await readdir(root, { withFileTypes: true });
    const names = files.filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name)).map((entry) => entry.name);
    names.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (!names.length) throw Object.assign(new Error('目录中未发现 Codex 本地会话索引。'), { code: 'NO_INDEX' });
    const db = new DatabaseSync(path.join(root, names[0]), { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
      const table = db.prepare("SELECT type FROM sqlite_master WHERE name = 'threads'").get();
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((column) => column.name));
      if (table?.type !== 'table' || !['id', 'title', 'cwd', 'created_at', 'updated_at', 'archived', 'rollout_path'].every((key) => columns.has(key))) {
        throw Object.assign(new Error('暂不支持此 Codex 会话索引格式。'), { code: 'UNSUPPORTED_INDEX' });
      }
      const optional = (name, fallback = 'NULL') => columns.has(name) ? name : fallback;
      const select = `SELECT id, title, cwd, archived, rollout_path,
        ${optional('name')} AS name, ${optional('model')} AS model,
        ${optional('model_provider')} AS model_provider,
        ${optional('tokens_used')} AS tokens_used, ${optional('source', "'unknown'")} AS source,
        COALESCE(${optional('created_at_ms')}, created_at * 1000) AS created_ms,
        COALESCE(${optional('updated_at_ms')}, updated_at * 1000) AS updated_ms FROM threads`;
      return { root, db, select, database: names[0] };
    } catch (error) {
      db.close();
      throw error;
    }
  }

  function sessionView(row) {
    return {
      id: row.id,
      title: (row.name?.trim() || row.title?.trim() || '未命名会话').slice(0, 1000),
      workspace: typeof row.cwd === 'string' ? row.cwd : '',
      model: row.model || '未记录模型',
      source: row.source === 'vscode' ? 'IDE / 桌面端' : row.source === 'cli' ? 'CLI' : '其他 / 子 Agent',
      archived: Boolean(row.archived),
      createdAt: row.created_ms,
      updatedAt: row.updated_ms,
      recordedTokens: Number.isSafeInteger(row.tokens_used) && row.tokens_used >= 0 ? row.tokens_used : null,
    };
  }

  async function scanRollout(root, row) {
    try {
      if (typeof row.rollout_path !== 'string' || !path.isAbsolute(row.rollout_path)) throw new Error('无效记录路径');
      const file = await realpath(row.rollout_path);
      if (!['sessions', 'archived_sessions'].some((directory) => inside(path.join(root, directory), file))) throw new Error('记录路径超出 Codex 会话目录');
      const stat = await lstat(file);
      if (!stat.isFile() || !file.endsWith('.jsonl') || stat.size > MAX_ROLLOUT_BYTES) throw new Error('记录文件不可读取或超出大小限制');
      const signature = `${stat.mtimeMs}:${stat.size}`;
      if (cache.get(file)?.signature === signature) return cache.get(file).data;
      const records = [];
      const events = [];
      let model = row.model || '未记录模型';
      let lastTurn = '暂无轮次记录';
      let skippedLines = 0;
      let legacyUsage = false;
      const input = createReadStream(file, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let readError;
      input.on('error', (error) => { readError = error; lines.close(); });
      try {
        for await (const line of lines) {
          if (!/^\s*\{[^{}]{0,512}"type"\s*:\s*"(?:turn_context|token_usage_record|event_msg)"/.test(line.slice(0, 1024))) continue;
          if (line.length > 1024 * 1024) { skippedLines += 1; continue; }
          let record;
          try { record = JSON.parse(line); } catch { skippedLines += 1; continue; }
          const payload = record.payload;
          if (!payload || typeof payload !== 'object') continue;
          const timestamp = Date.parse(record.timestamp);
          if (!Number.isFinite(timestamp)) continue;
          if (record.type === 'turn_context' && typeof payload.model === 'string') model = payload.model;
          if (record.type === 'token_usage_record') {
            if (typeof payload.response_id !== 'string' || !payload.response_id || !validTokens(payload.usage)) { skippedLines += 1; continue; }
            records.push({ id: payload.response_id, timestamp, model, input: payload.usage.input_tokens,
              cached: Number.isSafeInteger(payload.usage.cached_input_tokens) && payload.usage.cached_input_tokens >= 0 ? payload.usage.cached_input_tokens : 0,
              output: payload.usage.output_tokens, total: payload.usage.total_tokens, sessionId: row.id, agent: 'codex', provider: row.model_provider || 'openai', written: 0 });
            events.push({ timestamp, label: '模型响应已记录', detail: `${model} · ${payload.usage.total_tokens.toLocaleString('zh-CN')} Token` });
          }
          if (record.type === 'event_msg') {
            const labels = { task_started: ['任务开始', '最近轮次记录未结束'], task_complete: ['任务完成', '最近轮次已完成'], turn_aborted: ['任务中断', '最近轮次已中断'] };
            if (labels[payload.type]) {
              const [label, state] = labels[payload.type];
              lastTurn = state;
              events.push({ timestamp, label, detail: '来自本地执行记录' });
            }
            if (payload.type === 'token_count') legacyUsage = true;
          }
          if (events.length > 60) events.shift();
        }
        if (readError) throw readError;
      } finally {
        lines.close();
        input.destroy();
      }
      const data = { records, events: events.reverse(), lastTurn, partial: skippedLines > 0 || (legacyUsage && records.length === 0), unavailable: false };
      cache.set(file, { signature, data });
      if (cache.size > SESSION_LIMIT) cache.delete(cache.keys().next().value);
      return data;
    } catch {
      return { records: [], events: [], lastTurn: '执行记录暂不可读', partial: true, unavailable: true };
    }
  }

  async function readOverview(now) {
    let index;
    try {
      index = await openIndex();
      const totalSessions = index.db.prepare('SELECT COUNT(*) AS count FROM threads').get().count;
      const rows = index.db.prepare(`${index.select} ORDER BY updated_ms DESC, id DESC LIMIT ?`).all(SESSION_LIMIT);
      const sessions = rows.map(sessionView);
      const dayKeys = Array.from({ length: 7 }, (_, i) => dayFormatter.format(new Date(now - (6 - i) * 86400000)));
      const days = dayKeys.map((date) => ({ date, tokens: 0, calls: 0 }));
      const unique = new Map();
      let partialFiles = 0;
      for (const row of rows) {
        const scan = await scanRollout(index.root, row);
        if (scan.partial) partialFiles += 1;
        for (const record of scan.records) {
          if (record.timestamp > now) continue;
          const previous = unique.get(record.id);
          if (!previous || record.timestamp > previous.timestamp) unique.set(record.id, record);
        }
      }
      const models = new Map();
      const usage = { available: unique.size > 0, totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, calls: 0, days, models: [], partialFiles, scannedSessions: rows.length, totalSessions, timeZone: TIME_ZONE };
      for (const record of unique.values()) {
        const day = days.find((item) => item.date === dayFormatter.format(new Date(record.timestamp)));
        if (!day) continue;
        day.tokens += record.total;
        day.calls += 1;
        usage.totalTokens += record.total;
        usage.inputTokens += record.input;
        usage.cachedInputTokens += record.cached;
        usage.outputTokens += record.output;
        usage.calls += 1;
        const group = models.get(record.model) || { model: record.model, tokens: 0, calls: 0 };
        group.tokens += record.total;
        group.calls += 1;
        models.set(record.model, group);
      }
      usage.models = [...models.values()].sort((a, b) => b.tokens - a.tokens);
      return { connection: { status: 'connected', home: index.root, database: index.database }, sessions, records: [...unique.values()], totalSessions, limit: SESSION_LIMIT, usage, capturedAt: now };
    } catch (error) {
      const missing = ['ENOENT', 'NO_INDEX'].includes(error.code);
      const message = missing ? '未发现 Codex 本地会话索引，请选择 Codex 数据目录。'
        : error.code === 'UNSUPPORTED_INDEX' ? error.message : '无法读取 Codex 本地索引，请检查目录权限或稍后重试。';
      return { connection: { status: missing ? 'missing' : 'error', home: path.resolve(home), message }, sessions: [], totalSessions: 0, limit: SESSION_LIMIT, usage: null, capturedAt: now };
    } finally { index?.db.close(); }
  }

  return {
    overview(now = Date.now()) {
      if (!pending) pending = readOverview(now).finally(() => { pending = undefined; });
      return pending;
    },
    async details(id) {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('无效会话 ID。');
      const index = await openIndex();
      try {
        const row = index.db.prepare(`${index.select} WHERE id = ?`).get(id);
        if (!row) throw new Error('会话已不存在，请刷新列表。');
        const scan = await scanRollout(index.root, row);
        return { ...sessionView(row), events: scan.events, lastTurn: scan.lastTurn, partial: scan.partial };
      } finally { index.db.close(); }
    },
  };
}

module.exports = { createCodexReader };
