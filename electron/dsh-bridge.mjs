import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const localRequire = createRequire(process.env.ACC_DSH_PACKAGE);
const load = (name) => import(pathToFileURL(localRequire.resolve(name)).href);
const { installModelSelection } = await load('@deepseek-ai/dsh-agent');
const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
const { SessionId } = await load('@deepseek-ai/dsh-session');
export const name = 'acc-runner';
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'sessionPersistence', 'approval', 'userQuestions'];
const emit = (data) => process.stdout.write(JSON.stringify({ acc: true, ...data }) + '\n');

export function apply(ctx) {
  const exit = ctx.get('appExit');
  const decisions = new Map();
  let owned, request, resolveRequest, cancelled = false;
  const initial = new Promise((resolve) => { resolveRequest = resolve; });
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    try {
      const data = JSON.parse(line);
      if (data.type === 'start' && !request) { request = data; resolveRequest(data); }
      if (data.type === 'cancel') { cancelled = true; owned?.agent.cancel({ kind: 'user' }); }
      if (data.type === 'approval') { decisions.get(data.id)?.(data.allow ? 'allowed-once' : 'rejected'); decisions.delete(data.id); }
      if (data.type === 'answer') { decisions.get(data.id)?.({ answers: data.answers }); decisions.delete(data.id); }
    } catch { emit({ type: 'error', message: '控制消息格式错误。' }); }
  });
  ctx.on('approval/request', async (req, next) => {
    if (req.agent !== owned?.agent) return next();
    const id = randomUUID();
    const call = owned.agent.session.events.findLast((e) => e.type === 'tool/call' && (!req.callId || e.data?.call?.id === req.callId || e.data?.id === req.callId));
    emit({ type: 'approval', id, title: req.toolName, detail: req.reason || '', action: call?.data || {} });
    return new Promise((resolve) => {
      decisions.set(id, resolve);
      req.signal?.addEventListener('abort', () => { decisions.delete(id); resolve('cancelled'); emit({ type: 'approval-cancelled', id }); }, { once: true });
    });
  });
  ctx.get('userQuestions').registerProvider({ ask(req) {
    if (req.agent && req.agent !== owned?.agent) throw new Error('仅支持受控主 Agent 的提问。');
    const id = randomUUID(); emit({ type: 'question', id, questions: req.questions });
    return new Promise((resolve, reject) => {
      decisions.set(id, resolve);
      req.signal?.addEventListener('abort', () => { decisions.delete(id); reject(new Error('提问已取消。')); emit({ type: 'approval-cancelled', id }); }, { once: true });
    });
  } });
  async function run() {
    await ctx.get('loader')?.await();
    if (process.env.ACC_DSH_PROBE === '1') { emit({ type: 'ready', resume: typeof ctx.get('agents').resume === 'function' }); lines.close(); process.stdin.pause(); exit(0); return; }
    await initial;
    if (cancelled) { lines.close(); process.stdin.pause(); exit(0); return; }
    const selection = ctx.get('agentDefaultModel').currentSelection();
    const options = { agentOptions: { provider: selection.provider, model: selection.model }, setup: (agentCtx) => installModelSelection(agentCtx, { current: selection, assembled: undefined }) };
    const agents = ctx.get('agents');
    owned = request.sessionId ? await agents.resume({ ...options, resumeSessionId: SessionId(request.sessionId) }) : await agents.create({ ...options, sessionId: SessionId(`session-${randomUUID()}`), meta: { cwd: process.cwd() } });
    const agent = owned.agent;
    if (cancelled) agent.cancel({ kind: 'user' });
    await agent.whenIdle();
    emit({ type: 'session', id: agent.session.id, model: selection.model, provider: selection.provider });
    let offset = agent.session.events.length;
    const drain = () => {
      for (const e of agent.session.events.slice(offset)) {
        if (['assistant/message', 'turn/start', 'turn/end', 'tool/call', 'tool/result'].includes(e.type)) emit({ type: 'event', event: e });
      }
      offset = agent.session.events.length;
    };
    const timer = setInterval(drain, 150);
    try {
      if (!cancelled) agent.followup(createUserMessage({ content: [{ type: 'text', text: request.prompt }], source: { kind: 'user' } }));
      await agent.whenIdle(); drain();
      await ctx.get('sessions').flush(agent.session);
      const end = agent.session.events.findLast((e) => e.type === 'turn/end');
      emit({ type: 'result', status: cancelled || end?.data.reason.kind === 'aborted' ? 'cancelled' : end?.data.reason.kind === 'completed' ? 'completed' : 'failed' });
    } finally { clearInterval(timer); await owned.dispose(); lines.close(); }
    process.stdin.pause(); exit(0);
  }
  run().catch((error) => { emit({ type: 'error', message: error.message }); lines.close(); process.stdin.pause(); exit(1); });
}
