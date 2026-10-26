const { randomUUID, randomBytes } = require('node:crypto');
const net = require('node:net');
const { projectClaude, projectDsh, usageRecord, deduplicate } = require('./agent-readers.cjs');

function codexDriver(io, job) {
  let next = 1, turnId;
  const pending = new Map();
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} 响应超时。`)); }, 60000);
    pending.set(id, { resolve, reject, timer }); io.send({ id, method, params });
  });
  async function start() {
    await rpc('initialize', { clientInfo: { name: 'agent_control_center', title: 'Agent Control Center', version: '0.3.2' }, capabilities: { experimentalApi: true } });
    io.send({ method: 'initialized', params: {} });
    const params = { cwd: job.workspace, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', ...(job.model ? { model: job.model } : {}) };
    const result = await rpc(job.sessionId ? 'thread/resume' : 'thread/start', { ...params, ...(job.sessionId ? { threadId: job.sessionId } : {}) });
    io.session(result.thread.id);
    const turn = await rpc('turn/start', { threadId: result.thread.id, input: [{ type: 'text', text: job.prompt, text_elements: [] }] });
    turnId = turn.turn.id;
  }
  function message(msg) {
    if (msg.id !== undefined && !msg.method) {
      const request = pending.get(msg.id); if (!request) return;
      pending.delete(msg.id); clearTimeout(request.timer);
      msg.error ? request.reject(new Error(msg.error.message)) : request.resolve(msg.result); return;
    }
    const p = msg.params || {};
    if (msg.id !== undefined && msg.method) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(msg.method)) {
        io.approval(String(msg.id), msg.method, p, (allow) => io.send({ id: msg.id, result: { decision: allow ? 'accept' : 'decline' } }));
      } else if (msg.method === 'item/permissions/requestApproval') {
        io.approval(String(msg.id), '额外权限请求', p, (allow) => io.send({ id: msg.id, result: { permissions: allow ? p.permissions : {}, scope: 'turn' } }));
      } else if (msg.method === 'item/tool/requestUserInput') {
        io.question(String(msg.id), 'Codex 需要你的回答', p.questions.map((q) => ({ ...q, secret: q.isSecret })), (allow, answers) => io.send({ id: msg.id, result: { answers: Object.fromEntries(p.questions.map((q) => [q.id, { answers: allow ? [...answers[q.id].selected, ...(answers[q.id].custom ? [answers[q.id].custom] : [])] : [] }])) } }));
      } else io.send({ id: msg.id, error: { code: -32601, message: '控制中心暂不支持此交互，请在原 Agent 中处理。' } });
      return;
    }
    if (msg.method === 'turn/started') { turnId = p.turn?.id; io.running(); }
    if (msg.method === 'item/agentMessage/delta' || msg.method === 'item/commandExecution/outputDelta') io.log(p.delta || '');
    if (msg.method === 'item/started') io.log(`开始：${p.item?.type || '执行步骤'}`);
    if (msg.method === 'turn/completed') io.finish(p.turn.status === 'completed' ? 'completed' : p.turn.status === 'interrupted' ? 'cancelled' : 'failed', p.turn.error?.message);
    if (msg.method === 'error') io.log(p.error?.message || 'Codex 运行错误');
  }
  return { start, message, cancel: () => turnId && job.sessionId ? rpc('turn/interrupt', { threadId: job.sessionId, turnId }).catch(io.error) : undefined,
    dispose() { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Codex 进程已关闭。')); } pending.clear(); } };
}

function claudeDriver(io, job) {
  const init = randomUUID();
  const usage = new Map();
  const background = new Set();
  let started = false, sessionState, result;
  function maybeFinish() {
    if (result && !background.size && (sessionState === undefined || sessionState === 'idle')) io.finish(result.is_error || result.subtype !== 'success' ? 'failed' : 'completed', result.is_error ? (result.errors || []).join('; ') || result.result : undefined);
  }
  function message(msg) {
    if (msg.type === 'control_response' && msg.response?.request_id === init) {
      if (msg.response.subtype === 'error') return io.error(new Error(msg.response.error));
      if (!started) { started = true; io.send({ type: 'user', session_id: job.sessionId || '', message: { role: 'user', content: job.prompt }, parent_tool_use_id: null }); io.running(); }
    }
    if (msg.session_id) io.session(msg.session_id);
    if (msg.type === 'control_request') {
      const request = msg.request || {};
      if (request.subtype === 'can_use_tool') {
        const reply = (allow, answers) => io.send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: allow ? { behavior: 'allow', updatedInput: { ...request.input, ...(answers ? { answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, [...answer.selected, ...(answer.custom ? [answer.custom] : [])].join(', ')])) } : {}) } } : { behavior: 'deny', message: '用户在控制中心拒绝了此操作。' } } });
        if (request.tool_name === 'AskUserQuestion' && Array.isArray(request.input?.questions)) io.question(msg.request_id, 'Claude Code 需要你的回答', request.input.questions.map((q) => ({ ...q, id: q.question })), reply);
        else io.approval(msg.request_id, request.tool_name, request, reply);
      }
      else io.send({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: '暂不支持此控制请求。' } });
    }
    if (msg.type === 'control_cancel_request') io.withdraw(msg.request_id);
    if (msg.type === 'system') {
      if (msg.subtype === 'session_state_changed') sessionState = msg.state;
      if (msg.subtype === 'task_started' && ['local_agent', 'local_workflow'].includes(msg.task_type)) background.add(msg.task_id);
      if (msg.subtype === 'task_notification' || (msg.subtype === 'task_updated' && ['completed', 'failed', 'stopped'].includes(msg.patch?.status))) background.delete(msg.task_id);
      maybeFinish();
    }
    if ((msg.type === 'assistant' || msg.type === 'stream_event') && !msg.parent_tool_use_id) result = undefined;
    if (msg.type === 'stream_event') {
      const event = msg.event;
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') io.log(event.delta.text);
      if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') io.log(`工具：${event.content_block.name}`);
    }
    if (msg.type === 'assistant' && msg.message?.usage && msg.message.id) {
      const record = projectClaude([{ ...msg, sessionId: job.sessionId || msg.session_id, timestamp: new Date().toISOString(), cwd: job.workspace }], Date.now()).records[0];
      if (record) { const previous = usage.get(record.id); const merged = previous ? deduplicate([previous, record])[0] : record; usage.set(record.id, merged); io.capture(merged); }
    }
    if (msg.type === 'result') {
      if (typeof msg.result === 'string') io.log(msg.result);
      if (Number.isFinite(msg.total_cost_usd) && msg.total_cost_usd >= 0) {
        for (const record of usage.values()) io.capture({ ...record, reportedCost: '0', currency: 'USD', costCoveredBy: job.id });
        io.capture({ agent: 'claude', id: `cost-${job.id}`, sessionId: job.sessionId, timestamp: Date.now(), provider: 'anthropic', model: '本次任务原生费用', input: 0, cached: 0, written: 0, output: 0, total: 0, reportedCost: String(msg.total_cost_usd), currency: 'USD', costSummary: true });
      }
      result = msg; maybeFinish();
    }
  }
  return { start: () => io.send({ type: 'control_request', request_id: init, request: { subtype: 'initialize', hooks: null } }), message,
    cancel: () => io.send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }) };
}

function dshDriver(io, job) {
  return {
    start: () => io.send({ type: 'start', prompt: job.prompt, sessionId: job.sessionId }),
    cancel: () => io.send({ type: 'cancel' }),
    message(msg) {
      if (!msg.acc) return;
      if (msg.type === 'session') { io.session(msg.id); io.running(); }
      if (msg.type === 'approval') io.approval(msg.id, msg.title, { detail: msg.detail, action: msg.action }, (allow) => io.send({ type: 'approval', id: msg.id, allow }));
      if (msg.type === 'approval-cancelled') io.withdraw(msg.id);
      if (msg.type === 'question') io.question(msg.id, 'DSH 需要你的回答', msg.questions, (allow, answers) => io.send({ type: 'answer', id: msg.id, answers: allow ? Object.entries(answers).map(([id, answer]) => ({ id, selected: answer.selected, ...(answer.custom ? { custom: answer.custom } : {}) })) : [] }));
      if (msg.type === 'error') io.error(new Error(msg.message));
      if (msg.type === 'result') io.finish(msg.status);
      if (msg.type === 'event') {
        const event = msg.event;
        if (event.type === 'assistant/message') {
          for (const block of event.data.message?.content || []) if (block.type === 'text') io.log(block.text);
          const projected = projectDsh([{ type: 'session', id: job.sessionId, cwd: job.workspace }, event], Date.now());
          for (const record of projected.records) io.capture(record);
        } else io.log(event.type === 'tool/call' ? `工具调用：${event.data.name || event.data.call?.name || '执行工具'}` : event.type);
      }
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}
function opencodeDriver(io, job, port, password, fetchImpl = fetch) {
  const base = `http://127.0.0.1:${port}`, headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'Content-Type': 'application/json' };
  const seen = new Map(); let timer, disposed = false, sentAt = 0;
  async function request(route, method = 'GET', body) {
    const response = await fetchImpl(base + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`OpenCode ${route}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async function poll() {
    if (disposed) return;
    const id = encodeURIComponent(job.sessionId);
    const [messages, approvals, forms] = await Promise.all([request(`/api/session/${id}/message?limit=50&order=desc`), request(`/api/session/${id}/permission`), request(`/api/session/${id}/form`)]);
    if (disposed) return;
    const waiting = new Set();
    for (const approval of approvals.data || []) {
      waiting.add(approval.id);
      io.approval(approval.id, approval.action, approval, (allow) => request(`/api/session/${id}/permission/${encodeURIComponent(approval.id)}/reply`, 'POST', { decision: allow ? 'once' : 'reject' }));
    }
    for (const form of forms.data || []) {
      if (form.fields.some((field) => field.type === 'external')) throw new Error('OpenCode 请求了外部表单，请在原生 OpenCode 中续接此会话处理。');
      waiting.add(form.id);
      io.question(form.id, form.title, form.fields.map((field) => ({ id: field.key, question: field.title || field.key, detail: field.description, required: field.required, multiSelect: field.type === 'multiselect', options: (field.options || []).map((o) => ({ label: o.title || o.label || String(o.value), description: o.description })) })), async (allow, answers) => {
        if (!allow) return request(`/api/session/${id}/form/${encodeURIComponent(form.id)}`, 'DELETE');
        const answer = Object.fromEntries(form.fields.map((field) => {
          const a = answers[field.key], values = a.selected.map((label) => { const option = (field.options || []).find((o) => (o.title || o.label || String(o.value)) === label); return option?.value ?? label; });
          if (a.custom) values.push(a.custom);
          let value = field.type === 'multiselect' ? values : values[0] ?? field.default ?? '';
          if (['number', 'integer'].includes(field.type)) { value = Number(value); if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) throw new Error('请填写有效数字。'); }
          if (field.type === 'boolean') { if (!['true', 'false'].includes(String(value))) throw new Error('布尔问题请填写 true 或 false。'); value = String(value) === 'true'; }
          return [field.key, value];
        }));
        return request(`/api/session/${id}/form/${encodeURIComponent(form.id)}/reply`, 'POST', { answer });
      });
    }
    io.syncApprovals(waiting);
    for (const message of [...(messages.data || [])].reverse()) {
      if (message.time?.created < sentAt) continue;
      if (message.type === 'assistant') {
        const text = (message.content || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
        const previous = seen.get(message.id) || '';
        if (text !== previous) { io.log(text.startsWith(previous) ? text.slice(previous.length) : text); seen.set(message.id, text); }
        if (message.tokens) {
          const u = message.tokens;
          io.capture(usageRecord('opencode', message.id, job.sessionId, message.time.created, message.model?.id, message.model?.providerID,
            (u.input || 0) + (u.cache?.read || 0) + (u.cache?.write || 0), u.cache?.read, u.cache?.write, u.output, message.cost));
        }
      }
      if (message.type === 'idle' && message.time.created >= sentAt) { io.finish(message.outcome === 'succeeded' ? 'completed' : message.outcome === 'interrupted' ? 'cancelled' : 'failed'); return; }
    }
    timer = setTimeout(() => poll().catch(io.error), 800);
  }
  return {
    async start() {
      let ready = false;
      for (let i = 0; i < 80 && !disposed; i++) {
        try { const info = await request('/openapi.json'); if (!info.paths?.['/api/session/{sessionID}/prompt']) throw new Error('需要 OpenCode v2 服务。'); ready = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
      }
      if (disposed) return;
      if (!ready) throw new Error('OpenCode v2 服务启动超时。');
      if (!job.sessionId) {
        const model = job.model ? job.model.match(/^([^/]+)\/([^#]+)(?:#(.+))?$/) : null;
        if (job.model && !model) throw new Error('OpenCode 模型格式为 provider/model。');
        const result = await request('/api/session', 'POST', { title: job.prompt.slice(0, 60), location: { directory: job.workspace }, ...(model ? { model: { providerID: model[1], id: model[2], ...(model[3] ? { variant: model[3] } : {}) } } : {}) });
        io.session(result.data.id);
      } else {
        const existing = await request(`/api/session/${encodeURIComponent(job.sessionId)}`);
        if (existing.data?.location?.directory && existing.data.location.directory.toLowerCase() !== job.workspace.toLowerCase()) throw new Error('续接工作区与原会话不一致。');
      }
      if (disposed) return;
      sentAt = Date.now();
      await request(`/api/session/${encodeURIComponent(job.sessionId)}/prompt`, 'POST', { text: job.prompt });
      io.running(); await poll();
    },
    cancel: () => job.sessionId ? request(`/api/session/${encodeURIComponent(job.sessionId)}/interrupt`, 'POST') : undefined,
    dispose() { disposed = true; clearTimeout(timer); },
  };
}
module.exports = { codexDriver, claudeDriver, dshDriver, opencodeDriver, freePort, password: () => randomBytes(24).toString('base64url') };
