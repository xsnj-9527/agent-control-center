const { DatabaseSync } = require('node:sqlite');
const { realpath } = require('node:fs/promises');
const path = require('node:path');
const { findFiles, readRecords } = require('./record-files.cjs');

const AGENTS = { codex: 'Codex', opencode: 'OpenCode', dsh: 'DSH', claude: 'Claude Code' };
const tokens = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const timestamp = (value) => typeof value === 'number' ? value : Date.parse(value) || 0;
function usageRecord(agent, id, sessionId, time, model, provider, input, cached, written, output, cost) {
  return { agent, id: String(id), sessionId, timestamp: timestamp(time), model: String(model || '未记录模型'), provider: String(provider || '未记录供应商'),
    input: tokens(input), cached: tokens(cached), written: tokens(written), output: tokens(output), total: tokens(input) + tokens(output),
    ...(Number.isFinite(cost) && cost >= 0 ? { reportedCost: String(cost), currency: 'USD' } : {}) };
}

function projectClaude(rows, fallback) {
  const sessions = new Map();
  const records = [];
  for (const row of rows) {
    const id = row.sessionId;
    if (typeof id !== 'string') continue;
    let session = sessions.get(id);
    if (!session) { session = { id, title: 'Claude Code 会话', workspace: row.cwd || '', model: '未记录模型', createdAt: timestamp(row.timestamp) || fallback, updatedAt: fallback, archived: false, events: [] }; sessions.set(id, session); }
    if (row.type === 'custom-title' && typeof row.customTitle === 'string') session.title = row.customTitle.slice(0, 1000);
    if (row.cwd) session.workspace = row.cwd;
    const message = row.message;
    if (row.type !== 'assistant' || !message?.usage || !message.id) continue;
    const u = message.usage;
    const cached = tokens(u.cache_read_input_tokens), written = tokens(u.cache_creation_input_tokens);
    session.model = message.model || session.model;
    records.push(usageRecord('claude', message.id, id, row.timestamp, message.model, 'anthropic', tokens(u.input_tokens) + cached + written, cached, written, u.output_tokens));
  }
  return { sessions: [...sessions.values()], records };
}

function projectDsh(rows, fallback) {
  const header = rows.find((row) => row.type === 'session');
  if (!header?.id) return { sessions: [], records: [] };
  const session = { id: header.id, title: 'DSH 会话', workspace: header.cwd || '', model: '未记录模型', createdAt: timestamp(header.createdAt), updatedAt: fallback, archived: false, events: [] };
  const records = [];
  let provider;
  for (const row of rows) {
    const data = row.data || {};
    if (row.type === 'session/title' && typeof data.title === 'string') session.title = data.title.slice(0, 1000);
    if (row.type === 'model/selection') { session.model = data.model || session.model; provider = data.provider; }
    if (row.type === 'assistant/message' && data.usage && data.message?.id) {
      const u = data.usage, source = data.message.source || {};
      records.push(usageRecord('dsh', data.message.id, header.id, row.time, source.model || session.model, source.provider || provider,
        tokens(u.inputTokens) + tokens(u.cacheReadTokens) + tokens(u.cacheWriteTokens), u.cacheReadTokens, u.cacheWriteTokens, u.outputTokens));
    }
    if (['turn/start', 'turn/end', 'tool/call', 'tool/result'].includes(row.type)) session.events.push({ timestamp: timestamp(row.time), label: row.type, detail: row.type === 'turn/end' ? String(data.reason?.kind || '') : '本地事件摘要' });
  }
  session.events = session.events.slice(-60).reverse();
  return { sessions: [session], records };
}

function deduplicate(records) {
  const result = new Map();
  for (const record of records) {
    const key = `${record.agent}:${record.id}`;
    const old = result.get(key);
    // 同一个响应可能分块落盘或出现在分支中，仅保留一次最大用量。
    if (!old) result.set(key, { ...record });
    else {
      for (const field of ['input', 'cached', 'written', 'output']) old[field] = Math.max(old[field], record[field]);
      old.total = old.input + old.output;
      if (record.reportedCost !== undefined) old.reportedCost = record.reportedCost;
    }
  }
  return [...result.values()];
}

function createAgentReader(agent, home) {
  const cache = new Map();
  let latest;
  async function overview() {
    let db;
    try {
      const root = await realpath(home);
      let sessions = [], records = [], partialFiles = 0, totalSessions;
      if (agent === 'opencode') {
        db = new DatabaseSync(path.join(root, 'opencode.db'), { readOnly: true });
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
        const v2 = db.prepare("SELECT 1 FROM sqlite_master WHERE name='session_v2' AND type='table'").get();
        if (!v2) throw new Error('当前支持 OpenCode v2 本地索引，请升级 CLI 或选择 v2 数据目录。');
        totalSessions = db.prepare('SELECT COUNT(*) AS n FROM session_v2').get().n;
        const rows = db.prepare('SELECT id,title,directory,model,time_created,time_updated,time_archived FROM session_v2 ORDER BY time_updated DESC LIMIT 200').all();
        sessions = rows.map((r) => { let model; try { model = JSON.parse(r.model); } catch {} return { id: r.id, title: String(r.title || 'OpenCode 会话').slice(0, 1000), workspace: r.directory || '', model: model?.id || '未记录模型', createdAt: r.time_created, updatedAt: r.time_updated, archived: Boolean(r.time_archived), events: [] }; });
        const query = db.prepare(`SELECT id,time_created,
          json_extract(data,'$.model.id') AS model, json_extract(data,'$.model.providerID') AS provider,
          json_extract(data,'$.tokens.input') AS input, json_extract(data,'$.tokens.output') AS output,
          json_extract(data,'$.tokens.cache.read') AS cached,json_extract(data,'$.tokens.cache.write') AS written,
          json_extract(data,'$.cost') AS cost FROM session_message WHERE session_id=? AND type='assistant' AND json_valid(data)`);
        for (const session of sessions) for (const row of query.all(session.id)) {
          const record = usageRecord(agent, row.id, session.id, row.time_created, row.model, row.provider, tokens(row.input) + tokens(row.cached) + tokens(row.written), row.cached, row.written, row.output, row.cost);
          records.push(record);
        }
      } else {
        const directory = path.join(root, agent === 'claude' ? 'projects' : 'sessions');
        const files = await findFiles(directory, (name) => agent === 'claude' ? name.endsWith('.jsonl') : /\.jsonl(?:\.zstd)?$/.test(name), 4);
        totalSessions = files.length;
        for (const file of files.slice(0, 200)) {
          try {
            const signature = `${file.modified}:${file.size}`;
            let projected = cache.get(file.file);
            if (projected?.signature !== signature) {
              const read = await readRecords(directory, file.file);
              projected = { signature, partial: read.partial, ...(agent === 'claude' ? projectClaude(read.rows, file.modified) : projectDsh(read.rows, file.modified)) };
              cache.set(file.file, projected);
            }
            if (projected.partial) partialFiles++;
            sessions.push(...projected.sessions); records.push(...projected.records);
          } catch { partialFiles++; }
        }
        const live = new Set(files.slice(0, 200).map((file) => file.file));
        for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
      }
      sessions = [...new Map(sessions.map((session) => [session.id, session])).values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
      latest = { connection: { status: 'connected', home: root }, sessions: sessions.map((session) => ({ ...session, agent, source: AGENTS[agent], recordedTokens: null, lastTurn: '查看本地事件摘要' })), records: deduplicate(records), totalSessions, partialFiles };
    } catch (error) {
      latest = { connection: { status: error.code === 'ENOENT' ? 'missing' : 'error', home: path.resolve(home), message: error.code === 'ENOENT' ? '未发现本地数据目录，可手动选择。' : error.message }, sessions: [], records: [], totalSessions: 0, partialFiles: 0 };
    } finally { db?.close(); }
    return latest;
  }
  return { overview, async details(id) { if (!latest) await overview(); const session = latest.sessions.find((s) => s.id === id); if (!session) throw new Error('会话已不存在，请刷新。'); return session; } };
}

module.exports = { AGENTS, createAgentReader, projectClaude, projectDsh, deduplicate, usageRecord };
