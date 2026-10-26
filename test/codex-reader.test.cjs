const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync, copyFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { createCodexReader } = require('../electron/codex-reader.cjs');
const { createFixture } = require('./fixture.cjs');

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-control-center-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, ...createFixture(root) };
}

test('跨分支响应去重，缓存 Token 不重复相加，并使用 UTC+8 日期', async (t) => {
  const f = fixture(t);
  const result = await createCodexReader(f.home).overview(f.now);
  assert.equal(result.connection.status, 'connected');
  assert.equal(result.totalSessions, 3);
  assert.equal(result.usage.totalTokens, 1900);
  assert.equal(result.usage.calls, 2);
  assert.equal(result.usage.cachedInputTokens, 200);
  assert.equal(result.usage.days.at(-1).date, '2026-10-25');
  assert.equal(result.usage.days.at(-1).tokens, 1900);
  assert.equal(result.usage.models.length, 2);
});

test('只返回元数据和事件摘要，读取前后源文件保持不变', async (t) => {
  const f = fixture(t);
  const before = readFileSync(f.dbPath);
  const rollout = readFileSync(f.paths['session-a']);
  const reader = createCodexReader(f.home);
  const result = await reader.overview(f.now);
  const detail = await reader.details('session-a');
  assert.equal(detail.lastTurn, '最近轮次已完成');
  assert.equal(detail.recordedTokens, 99999);
  assert.ok(detail.events.some((event) => event.label === '任务完成'));
  assert.ok(!JSON.stringify([result, detail]).includes('不应显示的聊天正文'));
  assert.ok(!JSON.stringify([result, detail]).includes('fixture-secret-never-read'));
  assert.deepEqual(readFileSync(f.dbPath), before);
  assert.deepEqual(readFileSync(f.paths['session-a']), rollout);
});

test('拒绝读取会话目录以外的文件，并拒绝无效会话 ID', async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside.jsonl');
  writeFileSync(outside, JSON.stringify(f.response('outside-response', 8000)) + '\n');
  const db = new DatabaseSync(f.dbPath);
  db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(outside, 'session-b');
  db.close();
  const reader = createCodexReader(f.home);
  const result = await reader.overview(f.now);
  assert.equal(result.usage.totalTokens, 1200);
  assert.equal(result.usage.partialFiles, 1);
  assert.equal((await reader.details('session-b')).lastTurn, '执行记录暂不可读');
  await assert.rejects(reader.details("' OR 1=1 --"), /无效会话/);
});

test('旧累计计数不当作响应消耗，半写入行会被标记为不完整', async (t) => {
  const f = fixture(t);
  const legacy = f.event('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 999999 } } });
  Object.values(f.paths).forEach((file) => writeFileSync(file, JSON.stringify(legacy) + '\n{"type":"token_usage_record"'));
  const result = await createCodexReader(f.home).overview(f.now);
  assert.equal(result.usage.available, false);
  assert.equal(result.usage.totalTokens, 0);
  assert.equal(result.usage.partialFiles, 3);
});

test('刷新可以发现新写入的响应，重复请求共享同一次读取', async (t) => {
  const f = fixture(t);
  const reader = createCodexReader(f.home);
  const first = reader.overview(f.now);
  assert.equal(first, reader.overview(f.now));
  await first;
  appendFileSync(f.paths['session-a'], JSON.stringify(f.response('response-c', 600)) + '\n');
  assert.equal((await reader.overview(f.now)).usage.totalTokens, 2500);
});

test('缺失目录和未知索引格式会给出明确状态，不回退到演示数据', async (t) => {
  const f = fixture(t);
  assert.equal((await createCodexReader(path.join(f.root, 'missing')).overview()).connection.status, 'missing');
  const db = new DatabaseSync(f.dbPath);
  db.exec('DROP TABLE threads; CREATE TABLE threads(id TEXT)');
  db.close();
  assert.equal((await createCodexReader(f.home).overview()).connection.status, 'error');
});

test('按数字选择较新的索引版本，并限制列表大小', async (t) => {
  const f = fixture(t);
  copyFileSync(f.dbPath, path.join(f.home, 'state_10.sqlite'));
  const db = new DatabaseSync(path.join(f.home, 'state_10.sqlite'));
  const insert = db.prepare("INSERT INTO threads SELECT ?, title, name, cwd, model, source, tokens_used, created_at, updated_at, archived, rollout_path FROM threads WHERE id = 'session-a'");
  db.exec('BEGIN');
  for (let i = 0; i < 210; i += 1) insert.run(`extra-${i}`);
  db.exec('COMMIT');
  db.close();
  const result = await createCodexReader(f.home).overview(f.now);
  assert.equal(result.connection.database, 'state_10.sqlite');
  assert.equal(result.sessions.length, 200);
  assert.equal(result.totalSessions, 213);
});

test('兼容缺少可选模型、名称和 Token 字段的索引', async (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(path.join(f.home, 'state_6.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run('old-session', '兼容性记录', 'C:\\Projects', f.now / 1000, f.now / 1000, 0, f.paths['session-a']);
  db.close();
  const result = await createCodexReader(f.home).overview(f.now);
  assert.equal(result.connection.status, 'connected');
  assert.equal(result.sessions[0].title, '兼容性记录');
  assert.equal(result.sessions[0].model, '未记录模型');
  assert.equal(result.sessions[0].recordedTokens, null);
});
