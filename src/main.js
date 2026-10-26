const $ = (selector) => document.querySelector(selector);
const bridge = window.agentControl;
const names = { codex: 'Codex', opencode: 'OpenCode', dsh: 'DSH', claude: 'Claude Code' };
const states = { starting: '启动中', running: '执行中', waiting: '等待审批', stopping: '取消中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '意外中断' };
const live = (job) => ['starting', 'running', 'waiting', 'stopping'].includes(job.status);
const number = new Intl.NumberFormat('zh-CN');
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
let snapshot, billing, selectedJob, resumeJob, detailTrigger, setupAgent;
let page = 0, jobPage = 0, billPage = 0, busy = false, detailRequest = 0, jobsSignature = '', approvalsSignature = '', jobsPending = false, jobsAgain = false, billRequest = 0;
let jobs = [];
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function formatDate(time) { return Number.isFinite(time) && time > 0 ? date.format(time) : '—'; }
function amount(value, currency = '') { return value === null || value === undefined ? '未定价' : `${currency} ${Number(value).toLocaleString('en-US', { maximumFractionDigits: 9 })}`.trim(); }
function errorMessage(error) { return error?.message?.replace(/^.*Error: /, '') || '操作失败，请重试。'; }
function alertAt(id, message) { const node = $(id); node.textContent = message || ''; node.hidden = !message; }
function showError(message) { alertAt('#error', message); }
function announce(message) { $('#notice').textContent = message; }
function button(text, callback, className = 'text-button') { const node = element('button', className, text); node.type = 'button'; node.addEventListener('click', () => action(node, callback)); return node; }
async function action(node, callback, errorId = '#error') { node.disabled = true; try { await callback(); } catch (error) { alertAt(errorId, errorMessage(error)); } finally { node.disabled = false; } }
function cells(row, values) { values.forEach((text) => row.append(element('td', '', text))); }
function paging(prefix, current, total) { $(`${prefix}-range`).textContent = total ? `显示 ${current * 10 + 1}–${Math.min(total, current * 10 + 10)}，共 ${total} 条` : '暂无记录'; }
function renderChart(usage) {
  const svg = $('#usage-chart');
  svg.replaceChildren();
  const add = (tag, attributes, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text !== undefined) node.textContent = text;
    svg.append(node);
  };
  if (!usage?.available) {
    svg.setAttribute('aria-label', '暂无可核实的响应级用量记录');
    add('text', { x: 280, y: 105, 'text-anchor': 'middle', class: 'chart-axis' }, '暂无响应级用量记录');
    return;
  }
  svg.setAttribute('aria-label', `近七天已记录 ${number.format(usage.totalTokens)} Token，${number.format(usage.calls)} 次响应`);
  const max = Math.max(1, ...usage.days.map((day) => day.tokens));
  for (let i = 0; i < 4; i += 1) {
    const y = 180 - i * 47;
    add('line', { x1: 48, y1: y, x2: 530, y2: y, class: 'chart-grid' });
    add('text', { x: 0, y: y + 4, class: 'chart-axis' }, compact.format(max * i / 3));
  }
  const points = usage.days.map((day, i) => `${48 + i * 80},${180 - day.tokens / max * 141}`);
  add('polyline', { points: points.join(' '), class: 'chart-line' });
  usage.days.forEach((day, i) => {
    add('circle', { cx: 48 + i * 80, cy: 180 - day.tokens / max * 141, r: 4.5, class: 'chart-point' });
    add('text', { x: 48 + i * 80, y: 208, 'text-anchor': 'middle', class: 'chart-axis chart-day' }, day.date.slice(5).replace('-', '/'));
  });
}

function emptyRow(body, columns, message) {
  const row = element('tr');
  const cell = element('td', 'empty-state', message);
  cell.colSpan = columns;
  row.append(cell);
  body.append(row);
}


function renderUsage(usage) {
  $('#token-count').textContent = usage?.available ? compact.format(usage.totalTokens) : '—';
  renderChart(usage);
  $('#usage-note').textContent = `统计最近 ${usage.scannedSessions} / ${usage.totalSessions} 个会话；${usage.partialFiles} 个文件不完整或不可读。缺失记录未计入。`;
  $('#usage-breakdown').textContent = `输入 ${number.format(usage.inputTokens)} · 其中缓存命中 ${number.format(usage.cachedInputTokens)} · 输出 ${number.format(usage.outputTokens)} · ${number.format(usage.calls)} 次响应`;
  const body = $('#model-usage'); body.replaceChildren();
  if (!usage.models.length) emptyRow(body, 3, '暂无响应级用量记录');
  usage.models.slice(0, 30).forEach((model) => { const row = element('tr'); cells(row, [`${names[model.agent]} · ${model.model}`, number.format(model.calls), number.format(model.tokens)]); body.append(row); });
}
function renderAgents() {
  const body = $('#agent-rows'); body.replaceChildren();
  snapshot.agents.forEach((agent) => {
    const row = element('tr'), title = element('th'); title.scope = 'row';
    const name = element('span', 'agent-name'); name.append(element('span', `agent-mark agent-mark--${agent.id}`, agent.id === 'opencode' ? '</>' : agent.name[0]), element('span', '', agent.name));
    title.append(name, element('small', 'cli-version', agent.runtime.available ? agent.runtime.version : 'CLI 未安装'));
    const state = element('td'); state.append(element('span', `agent-status agent-status--${agent.connection.status === 'connected' ? 'running' : 'idle'}`, agent.connection.status === 'connected' ? '本地已接入' : '未接入'));
    const latest = snapshot.sessions.find((session) => session.agent === agent.id), running = jobs.find((job) => job.agent === agent.id && live(job));
    row.append(title, state, element('td', 'latest-session', latest?.title || '暂无会话'), element('td', running?.status === 'waiting' ? 'waiting-text' : 'muted', running ? states[running.status] : '空闲'));
    const control = element('td', 'row-actions'); control.append(button('设置', () => openSetup(agent.id)), button('新建', () => openTask(agent.id)));
    row.append(control); body.append(row);
  });
}
function renderOverview() {
  const count = snapshot.agents.filter((agent) => agent.connection.status === 'connected').length;
  $('#connection-status').textContent = `${count} 种 Agent 本地记录已接入`;
  $('#updated-at').textContent = formatDate(snapshot.capturedAt);
  $('#session-count').textContent = number.format(snapshot.totalSessions);
  $('#agent-count').textContent = `${count} / 4 已接入`;
  $('#history-coverage').textContent = `最近 ${snapshot.sessions.length} / ${snapshot.totalSessions} 个会话`;
  $('#footer-status').textContent = `历史每 30 秒刷新 · 实时任务持续更新`;
  const cost = snapshot.billingSummary.filter((total) => Number(total.local) !== 0);
  $('#cost-count').textContent = cost.length ? cost.map((total) => amount(total.local, total.currency)).join(' / ') : '查看台账';
  const activity = $('#activity-list'); activity.replaceChildren();
  if (!snapshot.sessions.length) activity.append(element('li', 'empty-state', '暂无本地会话，请检查 Agent 数据目录。'));
  snapshot.sessions.slice(0, 3).forEach((session) => {
    const item = element('li', 'activity-item'), copy = element('div', 'activity-copy'), title = element('p');
    title.append(element('strong', '', names[session.agent]), element('span', 'activity-title', session.title));
    copy.append(title, element('time', '', formatDate(session.updatedAt)), element('p', 'activity-detail', session.model));
    item.append(element('span', 'timeline-dot'), copy); activity.append(item);
  });
  renderAgents(); renderUsage(snapshot.usage); renderSessions();
}
function renderSessions() {
  if (!snapshot) return;
  const query = $('#session-search').value.trim().toLocaleLowerCase('zh-CN'), filter = $('#archive-filter').value, agent = $('#history-agent').value;
  $('#clear-search').hidden = !$('#session-search').value;
  const sessions = snapshot.sessions.filter((session) => (!agent || session.agent === agent) && (filter === 'all' || session.archived === (filter === 'archived')) && [session.title, session.workspace, session.model, names[session.agent]].some((value) => value.toLocaleLowerCase('zh-CN').includes(query)));
  page = Math.max(0, Math.min(page, Math.ceil(sessions.length / 10) - 1));
  const body = $('#session-rows'); body.replaceChildren();
  if (!sessions.length) emptyRow(body, 5, '暂无匹配的会话。');
  sessions.slice(page * 10, page * 10 + 10).forEach((session) => {
    const row = element('tr'), title = element('td', 'session-title');
    title.append(element('strong', '', session.title), element('small', '', session.workspace || '未记录工作区'));
    row.append(title); cells(row, [`${names[session.agent]} · ${session.model}`, formatDate(session.updatedAt), session.archived ? '已归档' : '未归档']);
    const control = element('td'); control.append(button('查看记录', async () => { detailTrigger = document.activeElement; await showDetails(session.agent, session.id); })); row.append(control); body.append(row);
  });
  $('#page-range').textContent = sessions.length ? `显示 ${page * 10 + 1}–${Math.min(page * 10 + 10, sessions.length)}，共 ${sessions.length} 条` : '0 条会话';
  $('#previous-page').disabled = page === 0; $('#next-page').disabled = (page + 1) * 10 >= sessions.length;
}
async function showDetails(agent, id) {
  const request = ++detailRequest; $('#session-detail').hidden = false; $('#detail-title').textContent = '正在读取执行记录…'; $('#detail-title').focus();
  $('#detail-metadata').replaceChildren(); $('#detail-events').replaceChildren(); alertAt('#detail-error', '');
  try {
    const detail = await bridge.details(agent, id); if (request !== detailRequest) return;
    $('#detail-title').textContent = detail.title;
    [['Agent', names[agent]], ['工作区', detail.workspace || '未记录'], ['模型', detail.model], ['会话 ID', detail.id], ['创建时间', formatDate(detail.createdAt)], ['最近活动', formatDate(detail.updatedAt)]].forEach(([label, value]) => $('#detail-metadata').append(element('dt', '', label), element('dd', '', value)));
    const events = detail.events || [];
    if (!events.length) $('#detail-events').append(element('li', 'empty-state', '此会话没有可用的任务事件摘要，用量已纳入统计。'));
    events.forEach((event) => { const item = element('li'); item.append(element('time', '', formatDate(event.timestamp)), element('strong', '', event.label), element('span', 'muted', event.detail)); $('#detail-events').append(item); });
    if (detail.partial) alertAt('#detail-error', '部分记录无法读取，当前内容可能不完整。');
  } catch (error) { if (request === detailRequest) alertAt('#detail-error', errorMessage(error)); }
}
function renderJobs() {
  const body = $('#job-rows'); body.replaceChildren();
  jobPage = Math.max(0, Math.min(jobPage, Math.ceil(jobs.length / 10) - 1));
  $('#running-count').textContent = `${jobs.filter(live).length} 个运行中`;
  if (!jobs.length) emptyRow(body, 5, '还没有受控任务。点击“新建任务”，选择 Agent 和工作区开始。');
  jobs.slice(jobPage * 10, jobPage * 10 + 10).forEach((job) => {
    const row = element('tr'), title = element('td', 'session-title'); title.append(element('strong', '', job.prompt), element('small', '', job.workspace)); row.append(title);
    cells(row, [names[job.agent], states[job.status] || job.status, formatDate(job.updatedAt)]);
    const control = element('td', 'row-actions'); control.append(button(job.status === 'waiting' ? '处理审批' : '查看日志', () => openJob(job.id)));
    if (live(job)) { const cancel = button(job.status === 'stopping' ? '取消中…' : '取消', () => bridge.cancel(job.id)); cancel.disabled = job.status === 'stopping'; control.append(cancel); }
    else if (job.sessionId) control.append(button('续接', () => openTask(job.agent, job)));
    row.append(control); body.append(row);
  });
  $('#job-range').textContent = `${jobs.length} 条执行记录`; $('#jobs-previous').disabled = jobPage === 0; $('#jobs-next').disabled = (jobPage + 1) * 10 >= jobs.length;
  if (snapshot) renderAgents();
}
async function openJob(id) { selectedJob = id; approvalsSignature = ''; $('#job-detail').hidden = false; await updateJobDetail(); $('#job-title').focus(); $('#job-detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
async function updateJobDetail() {
  const id = selectedJob, job = jobs.find((item) => item.id === id); if (!job) return;
  $('#job-title').textContent = `${names[job.agent]} · ${states[job.status]}`;
  $('#job-meta').textContent = `${job.workspace} · 会话 ${job.sessionId || '等待创建'}${job.error ? ` · ${job.error}` : ''}`;
  const signature = JSON.stringify(job.approvals);
  if (signature !== approvalsSignature) {
    approvalsSignature = signature; const area = $('#approvals'); area.replaceChildren();
    for (const approval of job.approvals || []) {
      const panel = element('section', 'approval-card'), pre = element('pre', '', approval.detail); pre.tabIndex = 0;
      panel.append(element('h4', '', `${approval.questions ? '等待回答' : '等待审批'}：${approval.title}`));
      const actions = element('div', 'header-actions');
      if (approval.questions) {
        const fields = [];
        for (const question of approval.questions) {
          const field = element('fieldset', 'question-field'); field.append(element('legend', '', question.question));
          if (question.detail) field.append(element('pre', '', question.detail));
          const choices = [];
          for (const option of question.options) {
            const label = element('label', 'question-option'), input = element('input'); input.type = question.multiSelect ? 'checkbox' : 'radio'; input.name = `question-${approval.id}-${question.id}`;
            label.append(input, element('span', '', `${option.label}${option.description ? `：${option.description}` : ''}`)); field.append(label); choices.push({ input, label: option.label });
          }
          const label = element('label', '', question.options.length ? '补充或自定义回答' : '你的回答'), input = element('input', 'question-input'); input.type = question.secret ? 'password' : 'text'; input.maxLength = 4000; label.append(input); field.append(label);
          fields.push({ question, choices, input }); panel.append(field);
        }
        const localError = element('p', 'inline-alert'); localError.hidden = true; localError.setAttribute('role', 'alert'); panel.append(localError);
        actions.append(button('提交回答', async () => {
          try { await bridge.respond(job.id, approval.id, Object.fromEntries(fields.map(({ question, choices, input }) => [question.id, { selected: choices.filter((choice) => choice.input.checked).map((choice) => choice.label), custom: input.value }]))); }
          catch (error) { localError.textContent = errorMessage(error); localError.hidden = false; }
        }, 'primary-button'));
      } else { panel.append(pre); actions.append(button('允许本次', () => bridge.approve(job.id, approval.id, true), 'primary-button')); }
      actions.append(button('拒绝', () => bridge.approve(job.id, approval.id, false), 'refresh-button')); panel.append(actions); area.append(panel);
    }
  }
  const logs = await bridge.logs(id); if (selectedJob !== id) return;
  const text = logs.map((line) => `[${formatDate(line.time)}] ${line.text}`).join('\n') || '等待 Agent 输出…';
  const log = $('#job-log'); if (log.textContent !== text) { log.textContent = text; if ($('#follow-log').checked) log.scrollTop = log.scrollHeight; }
}
async function updateJobs() {
  if (!bridge) return;
  if (jobsPending) { jobsAgain = true; return; } jobsPending = true;
  try {
    const next = await bridge.jobs(), signature = JSON.stringify(next); jobs = next;
    if (signature !== jobsSignature) { const previouslyLive = jobsSignature.includes('"running"') || jobsSignature.includes('"waiting"') || jobsSignature.includes('"stopping"'); jobsSignature = signature; renderJobs(); if (previouslyLive && !jobs.some(live)) { refresh(); loadBilling(); } }
    if (selectedJob) await updateJobDetail();
  } catch (error) { showError(errorMessage(error)); }
  finally { jobsPending = false; if (jobsAgain) { jobsAgain = false; updateJobs(); } }
}
function openTask(agent = 'codex', previous) {
  resumeJob = previous; $('#task-form').reset(); $('#task-agent').value = agent; $('#task-agent').disabled = Boolean(previous);
  $('#task-workspace').value = previous?.workspace || ''; $('#task-model').value = previous?.model || '';
  $('#task-dialog-title').textContent = previous ? `续接 ${names[agent]} 会话` : '新建任务';
  alertAt('#task-error', ''); modelHint(); $('#task-dialog').showModal();
}
function modelHint() { const dsh = $('#task-agent').value === 'dsh'; $('#task-model').disabled = dsh || Boolean(resumeJob); $('#model-hint').textContent = dsh ? 'DSH 使用其本机默认模型配置。' : resumeJob ? '续接沿用原会话与模型；请输入下一步任务。' : ''; }
async function openSetup(agentId) {
  setupAgent = agentId; renderSetup(); alertAt('#setup-error', ''); $('#setup-dialog').showModal();
}
function renderSetup() {
  const agent = snapshot.agents.find((item) => item.id === setupAgent), area = $('#setup-content'); area.replaceChildren(); $('#setup-title').textContent = `${agent.name} 接入设置`;
  area.append(element('p', '', `本地数据：${agent.connection.home}`), element('p', 'section-note', agent.connection.message || `已扫描 ${agent.scanned} / ${agent.count} 个会话`), element('p', '', `CLI：${agent.runtime.file || '未发现'}`), element('p', 'section-note', agent.runtime.version));
  for (const [label, callback] of [['选择数据目录', () => bridge.chooseHome(setupAgent)], ['选择 CLI', () => bridge.chooseCli(setupAgent)]]) {
    const node = element('button', 'refresh-button', label); node.type = 'button'; node.addEventListener('click', () => action(node, async () => { const result = await callback(); if (result) { snapshot = result; renderOverview(); renderSetup(); await loadBilling(); } }, '#setup-error')); area.append(node);
  }
}
const billFilter = () => ({ month: $('#bill-month').value, ...($('#bill-agent').value ? { agent: $('#bill-agent').value } : {}) });
async function loadBilling() {
  if (!bridge) return;
  const request = ++billRequest;
  try { const result = await bridge.billing(billFilter()); if (request !== billRequest) return; billing = result; renderBilling(); if (!$('#bill-agent').value && $('#bill-month').value === new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(Date.now())) { const totals = result.totals.filter((total) => Number(total.local)); $('#cost-count').textContent = totals.length ? totals.map((total) => amount(total.local, total.currency)).join(' / ') : '查看台账'; } if ($('#rate-dialog').open) renderRates(); }
  catch (error) { if (request === billRequest) showError(errorMessage(error)); }
}
function renderBilling() {
  if (!billing) return;
  const totals = $('#bill-totals'); totals.replaceChildren();
  billing.totals.forEach((total) => { const row = element('tr'); cells(row, [total.currency, amount(total.reported), amount(total.estimated), amount(total.local), total.invoiceCount ? amount(total.invoice) : '未导入', total.invoiceCount ? amount(total.difference) : '—']); totals.append(row); });
  $('#bill-coverage').textContent = `${billing.rows.filter((r) => !r.costSummary).length} 次响应 · ${billing.unpriced} 次未定价`;
  billPage = Math.max(0, Math.min(billPage, Math.ceil(billing.rows.length / 10) - 1));
  const body = $('#bill-rows'); body.replaceChildren(); if (!billing.rows.length) emptyRow(body, 5, '此账期暂无记录。');
  billing.rows.slice(billPage * 10, billPage * 10 + 10).forEach((record) => { const row = element('tr'); cells(row, [`${formatDate(record.timestamp)} · ${names[record.agent]}`, `${record.provider} / ${record.model}`, record.costSummary ? '费用汇总' : number.format(record.total), record.costCoveredBy ? '已含于任务原生费用' : ({ reported: '已记录', estimated: '费率估算', unpriced: '未定价' }[record.source]), amount(record.amount, record.currency)]); body.append(row); });
  paging('#bill', billPage, billing.rows.length); $('#bill-previous').disabled = billPage === 0; $('#bill-next').disabled = (billPage + 1) * 10 >= billing.rows.length;
  const invoices = $('#invoice-rows'); invoices.replaceChildren(); if (!billing.invoices.length) emptyRow(invoices, 5, '尚未导入账单。');
  billing.invoices.forEach((invoice) => { const row = element('tr'); cells(row, [`${invoice.date} / ${invoice.id}`, names[invoice.agent], amount(invoice.amount, invoice.currency), invoice.note]); const control = element('td'); control.append(button('删除', async () => { await bridge.removeBill(invoice.id); await loadBilling(); })); row.append(control); invoices.append(row); });
}
function fillRate(rate) { for (const key of ['agent', 'provider', 'model', 'currency', 'input', 'cached', 'written', 'output']) $(`#rate-${key}`).value = rate[key] ?? (key === 'currency' ? 'USD' : ''); $('#rate-provider').focus(); }
function renderRates() {
  const missing = $('#missing-rates'); missing.replaceChildren();
  if (billing.missingRates.length) { missing.append(element('h3', '', '未定价模型')); billing.missingRates.forEach((rate) => missing.append(button(`${names[rate.agent]} · ${rate.provider} / ${rate.model} ＋`, () => fillRate(rate), 'rate-chip'))); }
  const saved = $('#saved-rates'); saved.replaceChildren(); saved.append(element('h3', '', '已保存费率'));
  if (!billing.rates.length) saved.append(element('p', 'section-note', '尚无费率。请填写你所用供应商的实际单价。'));
  billing.rates.forEach((rate) => { const row = element('div', 'saved-rate'); row.append(element('p', '', `${names[rate.agent]} · ${rate.provider} / ${rate.model} · ${rate.currency}（输入 ${rate.input} / 缓存读 ${rate.cached} / 缓存写 ${rate.written} / 输出 ${rate.output}）`), button('编辑', () => fillRate(rate)), button('删除', async () => { await bridge.deleteRate(rate); await loadBilling(); })); saved.append(row); });
}
async function refresh(manual = false) {
  if (busy || !bridge) return; busy = true; $('#refresh').disabled = true; $('main').setAttribute('aria-busy', 'true');
  try { snapshot = await bridge.overview(); jobs = snapshot.jobs; jobsSignature = JSON.stringify(jobs); renderOverview(); renderJobs(); await loadBilling(); if (manual) announce('本地记录已刷新。'); }
  catch (error) { showError(errorMessage(error)); }
  finally { busy = false; $('#refresh').disabled = false; $('main').setAttribute('aria-busy', 'false'); }
}
$('#refresh').addEventListener('click', () => refresh(true));
$('#new-task').addEventListener('click', () => openTask());
$('#task-agent').addEventListener('change', modelHint);
$('#pick-workspace').addEventListener('click', () => action($('#pick-workspace'), async () => { const directory = await bridge.chooseWorkspace(); if (directory) $('#task-workspace').value = directory; }, '#task-error'));
$('#task-form').addEventListener('submit', (event) => { event.preventDefault(); action($('#start-task'), async () => { const job = await bridge.start({ agent: $('#task-agent').value, workspace: $('#task-workspace').value, prompt: $('#task-prompt').value, model: $('#task-agent').value === 'dsh' ? '' : $('#task-model').value, ...(resumeJob ? { resumeJobId: resumeJob.id } : {}) }); if (job) { $('#task-dialog').close(); await updateJobs(); await openJob(job.id); } }, '#task-error'); });
for (const node of document.querySelectorAll('[data-close]')) node.addEventListener('click', () => $(`#${node.dataset.close}`).close());
$('#close-job').addEventListener('click', () => { selectedJob = null; $('#job-detail').hidden = true; $('#tasks-title').focus(); });
$('#jobs-previous').addEventListener('click', () => { jobPage--; renderJobs(); }); $('#jobs-next').addEventListener('click', () => { jobPage++; renderJobs(); });
$('#session-search').addEventListener('input', (event) => { if (!event.isComposing) { page = 0; renderSessions(); } }); $('#session-search').addEventListener('compositionend', () => { page = 0; renderSessions(); });
$('#clear-search').addEventListener('click', () => { $('#session-search').value = ''; page = 0; renderSessions(); $('#session-search').focus(); });
for (const id of ['archive-filter', 'history-agent']) $(`#${id}`).addEventListener('change', () => { page = 0; renderSessions(); });
$('#previous-page').addEventListener('click', () => { page--; renderSessions(); }); $('#next-page').addEventListener('click', () => { page++; renderSessions(); });
$('#close-detail').addEventListener('click', () => { detailRequest++; $('#session-detail').hidden = true; if (detailTrigger?.isConnected) detailTrigger.focus(); else $('#session-search').focus(); });
$('#bill-month').value = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(Date.now());
for (const id of ['bill-month', 'bill-agent']) $(`#${id}`).addEventListener('change', () => { billPage = 0; loadBilling(); });
$('#bill-previous').addEventListener('click', () => { billPage--; renderBilling(); }); $('#bill-next').addEventListener('click', () => { billPage++; renderBilling(); });
$('#import-bill').addEventListener('click', () => action($('#import-bill'), async () => { const result = await bridge.importBill(); if (result) { announce(`导入 ${result.added} 条，跳过 ${result.duplicates} 条重复账单。`); await loadBilling(); } }));
$('#export-bill').addEventListener('click', () => action($('#export-bill'), async () => { const file = await bridge.exportBill(billFilter()); if (file) announce(`台账已导出：${file}`); }));
$('#edit-rates').addEventListener('click', async () => { if (!billing) await loadBilling(); if (!billing) return; renderRates(); alertAt('#rate-error', ''); $('#rate-dialog').showModal(); });
$('#rate-form').addEventListener('submit', (event) => { event.preventDefault(); action($('#rate-form button[type="submit"]'), async () => { const rate = Object.fromEntries(['agent', 'provider', 'model', 'currency', 'input', 'cached', 'written', 'output'].map((key) => [key, $(`#rate-${key}`).value])); await bridge.saveRate(rate); alertAt('#rate-error', ''); await loadBilling(); announce('费率已保存并重新计算。'); }, '#rate-error'); });
function updateCurrentSection() { const hash = window.location.hash || '#overview'; for (const link of document.querySelectorAll('.nav-link')) { link.classList.toggle('nav-link--selected', link.hash === hash); if (link.hash === hash) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); } }
window.addEventListener('hashchange', updateCurrentSection); updateCurrentSection();
if (bridge) { bridge.onChanged(updateJobs); refresh(); window.setInterval(() => { if (!document.hidden) refresh(); }, 30000); }
else { $('#connection-status').textContent = '请启动桌面应用以接入本地 Agent。'; $('#new-task').disabled = true; $('#refresh').disabled = true; }
