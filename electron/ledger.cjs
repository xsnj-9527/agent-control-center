const { DatabaseSync } = require('node:sqlite');
const { AGENTS, deduplicate } = require('./agent-readers.cjs');
const { randomUUID } = require('node:crypto');

const SCALE = 1000000000n;
const rateKey = (rate) => JSON.stringify([rate.agent, rate.provider, rate.model]);
function units(value, signed = false) {
  const text = String(value);
  if (!(signed ? /^-?\d{1,12}(?:\.\d{1,9})?$/ : /^\d{1,12}(?:\.\d{1,9})?$/).test(text)) throw new Error('金额需为最多 9 位小数的十进制数字。');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(9, '0'));
  return negative ? -result : result;
}
function decimal(value) {
  const n = BigInt(value), abs = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${abs / SCALE}.${String(abs % SCALE).padStart(9, '0')}`;
}
function money(value) {
  // 已记录的浮点费用来自原始索引，先固定为纳币单位再参与整数汇总。
  return units(Number(value).toFixed(9));
}
function checkedRate(rate) {
  if (!rate || !Object.hasOwn(AGENTS, rate.agent) || !['USD', 'CNY'].includes(rate.currency)) throw new Error('无效 Agent 或币种。');
  for (const key of ['provider', 'model']) if (typeof rate[key] !== 'string' || !rate[key].trim() || rate[key].length > 200) throw new Error('请填写供应商和完整模型名。');
  const result = { agent: rate.agent, provider: rate.provider.trim(), model: rate.model.trim(), currency: rate.currency };
  for (const key of ['input', 'cached', 'written', 'output']) { units(rate[key]); result[key] = String(rate[key]); }
  return result;
}
function estimate(record, rate) {
  const cached = Math.min(record.input, record.cached), written = Math.min(record.input - cached, record.written);
  const weighted = BigInt(record.input - cached - written) * units(rate.input) + BigInt(cached) * units(rate.cached) + BigInt(written) * units(rate.written) + BigInt(record.output) * units(rate.output);
  return (weighted + 500000n) / 1000000n;
}
function parseCsv(text) {
  if (Buffer.byteLength(text) > 5 * 1024 * 1024) throw new Error('CSV 最大 5 MB。');
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += ch; }
    else if (ch === '"') { if (field || closed) throw new Error('CSV 引号格式错误。'); quoted = true; }
    else if (ch === ',' || ch === '\n' || ch === '\r') {
      row.push(field); field = ''; closed = false;
      if (ch !== ',') { if (ch === '\r' && text[i + 1] === '\n') i++; if (row.some(Boolean)) rows.push(row); row = []; }
    } else { if (closed) throw new Error('CSV 引号后存在非法字符。'); field += ch; }
    if (field.length > 10000 || rows.length > 10000) throw new Error('CSV 超出 10000 行或字段长度限制。');
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号。');
  row.push(field); if (row.some(Boolean)) rows.push(row);
  if (rows.shift()?.join(',') !== 'id,date,agent,amount,currency,note') throw new Error('CSV 表头须为 id,date,agent,amount,currency,note。');
  return rows.map((r, i) => {
    const [id, date, agent, amount, currency, note] = r;
    if (r.length !== 6 || !id || id.length > 200 || !Object.hasOwn(AGENTS, agent) || !['USD', 'CNY'].includes(currency) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error(`CSV 第 ${i + 2} 行格式无效。`);
    units(amount, true);
    return { id, date, agent, amount: decimal(units(amount, true)), currency, note: note.slice(0, 1000) };
  });
}
function csv(rows) {
  const safe = (value) => { const text = String(value ?? ''); return `"${(/^[\s]*[=+@-]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`; };
  return '\uFEFF' + rows.map((row) => row.map(safe).join(',')).join('\r\n');
}
function createLedger(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS logs(job_id TEXT,seq INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER,text TEXT);
    CREATE INDEX IF NOT EXISTS log_job ON logs(job_id,seq);
    CREATE TABLE IF NOT EXISTS rates(key TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS captured(key TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  const list = (table) => db.prepare(`SELECT data FROM ${table}`).all().map((row) => JSON.parse(row.data));
  const put = (table, key, value) => db.prepare(`INSERT OR REPLACE INTO ${table}(${table === 'jobs' || table === 'invoices' ? 'id' : 'key'},data) VALUES(?,?)`).run(key, JSON.stringify(value));
  // 应用异常退出后的旧进程状态不能继续显示为运行中。
  for (const job of list('jobs')) if (['starting', 'running', 'waiting', 'stopping'].includes(job.status)) put('jobs', job.id, { ...job, status: 'interrupted', updatedAt: Date.now(), error: '上次应用异常退出；请确认原任务已停止后再续接。' });
  return {
    jobs: () => list('jobs').sort((a, b) => b.createdAt - a.createdAt),
    saveJob: (job) => put('jobs', job.id, job),
    logs: (id) => db.prepare('SELECT seq,time,text FROM (SELECT seq,time,text FROM logs WHERE job_id=? ORDER BY seq DESC LIMIT 500) ORDER BY seq').all(id),
    log(id, text) { db.prepare('INSERT INTO logs(job_id,time,text) VALUES(?,?,?)').run(id, Date.now(), text.slice(0, 8000)); db.prepare('DELETE FROM logs WHERE job_id=? AND seq < COALESCE((SELECT seq FROM logs WHERE job_id=? ORDER BY seq DESC LIMIT 1 OFFSET 1999),0)').run(id, id); },
    capture: (record) => put('captured', `${record.agent}:${record.id}`, record),
    saveRate(rate) { rate = checkedRate(rate); put('rates', rateKey(rate), rate); return rate; },
    deleteRate(rate) { db.prepare('DELETE FROM rates WHERE key=?').run(rateKey(checkedRate(rate))); },
    importCsv(text) {
      const rows = parseCsv(text); let added = 0, duplicates = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          const old = db.prepare('SELECT data FROM invoices WHERE id=?').get(row.id);
          if (old) { if (old.data !== JSON.stringify(row)) throw new Error(`账单 ID ${row.id} 已存在且内容不同，已取消本次导入。`); duplicates++; }
          else { put('invoices', row.id, row); added++; }
        }
        db.exec('COMMIT'); return { added, duplicates };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    removeInvoice(id) { if (typeof id !== 'string') throw new Error('无效账单 ID。'); db.prepare('DELETE FROM invoices WHERE id=?').run(id); },
    billing(records, filter = {}) {
      const month = filter.month || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(Date.now());
      if (!/^\d{4}-\d{2}$/.test(month) || (filter.agent && !Object.hasOwn(AGENTS, filter.agent))) throw new Error('无效账期或 Agent。');
      const rates = list('rates'), day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
      const merged = new Map(deduplicate(records).map((r) => [`${r.agent}:${r.id}`, r]));
      // 受控任务采集到的原生费用覆盖相同响应的历史估算，避免重复计费。
      for (const record of list('captured')) merged.set(`${record.agent}:${record.id}`, record);
      const rows = [], sums = { USD: { reported: 0n, estimated: 0n, invoice: 0n }, CNY: { reported: 0n, estimated: 0n, invoice: 0n } };
      let unpriced = 0;
      const missing = new Map();
      for (const record of merged.values()) {
        if (!Number.isFinite(record.timestamp) || !day.format(record.timestamp).startsWith(month) || (filter.agent && record.agent !== filter.agent)) continue;
        const rate = rates.find((r) => r.agent === record.agent && r.provider === record.provider && r.model === record.model);
        let amount, source, currency;
        if (record.reportedCost !== undefined) { amount = money(record.reportedCost); source = 'reported'; currency = record.currency || 'USD'; }
        else if (rate) { amount = estimate(record, rate); source = 'estimated'; currency = rate.currency; }
        else { unpriced++; source = 'unpriced'; missing.set(rateKey(record), { agent: record.agent, provider: record.provider, model: record.model }); }
        if (currency && sums[currency]) sums[currency][source] += amount;
        rows.push({ ...record, source, currency, amount: amount === undefined ? null : decimal(amount) });
      }
      const invoices = list('invoices').filter((r) => r.date.startsWith(month) && (!filter.agent || r.agent === filter.agent));
      for (const invoice of invoices) sums[invoice.currency].invoice += units(invoice.amount, true);
      const totals = Object.entries(sums).map(([currency, s]) => { const invoiceCount = invoices.filter((invoice) => invoice.currency === currency).length; return { currency, reported: decimal(s.reported), estimated: decimal(s.estimated), local: decimal(s.reported + s.estimated), invoice: decimal(s.invoice), invoiceCount, difference: invoiceCount ? decimal(s.invoice - s.reported - s.estimated) : null }; });
      return { month, rates, missingRates: [...missing.values()], totals, unpriced, rows: rows.sort((a, b) => b.timestamp - a.timestamp), invoices };
    },
    exportCsv(billing) { return csv([['date', 'agent', 'provider', 'model', 'response_id', 'tokens', 'source', 'amount', 'currency'], ...billing.rows.map((r) => [new Date(r.timestamp).toISOString(), r.agent, r.provider, r.model, r.id, r.total, r.source, r.amount ?? '', r.currency || ''])]); },
    close: () => db.close(),
  };
}
module.exports = { createLedger, units, decimal, estimate, parseCsv, csv, checkedRate };
