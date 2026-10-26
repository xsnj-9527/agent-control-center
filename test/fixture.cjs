const { DatabaseSync } = require('node:sqlite');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

function createFixture(root, extraSessions = 0) {
  const home = path.join(root, 'codex-home');
  const sessions = path.join(home, 'sessions/2026/10/25');
  mkdirSync(sessions, { recursive: true });
  const now = Date.parse('2026-10-25T12:00:00Z');
  const dbPath = path.join(home, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, model TEXT, source TEXT, tokens_used INTEGER, created_at INTEGER, updated_at INTEGER, archived INTEGER, rollout_path TEXT)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const event = (type, payload, timestamp = '2026-10-25T08:00:00Z') => ({ timestamp, type, payload });
  const response = (id, total, timestamp = '2026-10-25T08:01:00Z') => event('token_usage_record', { response_id: id, usage: { input_tokens: total - 200, cached_input_tokens: 100, output_tokens: 200, total_tokens: total } }, timestamp);
  const paths = {};
  function add(id, title, archived, records, index = 0) {
    const file = path.join(sessions, `rollout-${id}.jsonl`);
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    insert.run(id, title, title, `C:\\Projects\\${id}`, 'test-model', 'vscode', 99999, Math.floor(now / 1000) - 86400, Math.floor(now / 1000) - index, archived, file);
    paths[id] = file;
  }
  const shared = [event('turn_context', { model: 'test-model' }), event('response_item', { type: 'message', text: '不应显示的聊天正文' }), event('event_msg', { type: 'task_started' }), response('response-a', 1200), event('event_msg', { type: 'task_complete' }, '2026-10-25T08:02:00Z')];
  add('session-a', '重构日志采集器', 0, shared);
  add('session-fork', '日志采集器分支', 0, shared, 1);
  add('session-b', '登录页验证记录', 1, [event('turn_context', { model: 'second-model' }), response('response-b', 700, '2026-10-24T16:30:00Z')], 2);
  for (let i = 0; i < extraSessions; i += 1) add(`history-${i}`, `历史任务 ${i + 1}`, 0, [], i + 3);
  db.close();
  writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ token: 'fixture-secret-never-read' }));
  return { home, dbPath, now, paths, event, response };
}

module.exports = { createFixture };
