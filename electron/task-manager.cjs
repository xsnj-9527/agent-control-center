const { spawn } = require('node:child_process');
const { realpath, stat } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const path = require('node:path');
const { AGENTS } = require('./agent-readers.cjs');
const { dshPatch } = require('./cli-runtime.cjs');
const { codexDriver, claudeDriver, dshDriver, opencodeDriver, freePort, password } = require('./task-drivers.cjs');

function redact(text) {
  return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{20,})\b/g, '[已隐藏密钥]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password)\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s,"'}]+/gi, '$1[已隐藏]');
}
function createTaskManager({ ledger, runtimes, homes, runtimeDir, onChange = () => {}, spawnImpl = spawn, fetchImpl }) {
  const active = new Map();
  const starting = new Set();
  const changed = () => onChange();
  function jobs() { return ledger.jobs().map((job) => ({ ...job, approvals: [...(active.get(job.id)?.approvals.values() || [])].map(({ callback, ...view }) => view) })); }
  async function start(input) {
    if (!input || !Object.hasOwn(AGENTS, input.agent) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000) throw new Error('请选择 Agent，并输入 1–32000 字的任务。');
    if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) throw new Error('请选择绝对路径的工作区。');
    if (typeof input.model !== 'undefined' && (typeof input.model !== 'string' || input.model.length > 200 || /[\r\n\0]/.test(input.model))) throw new Error('模型名格式无效。');
    const runtime = runtimes[input.agent];
    if (!runtime?.available) throw new Error('未找到该 Agent CLI，请先安装或在接入设置中指定可执行文件。');
    if (starting.has(input.agent) || [...active.values()].some((entry) => entry.job.agent === input.agent)) throw new Error('此 Agent 已有运行中的任务，请等待结束或取消。');
    starting.add(input.agent);
    try {
      const workspace = await realpath(input.workspace);
      if (!(await stat(workspace)).isDirectory()) throw new Error('工作区必须是现有目录。');
      let original;
      if (input.resumeJobId) {
        original = ledger.jobs().find((job) => job.id === input.resumeJobId);
        if (!original || original.agent !== input.agent || !original.sessionId || original.workspace.toLowerCase() !== workspace.toLowerCase()) throw new Error('无法续接此任务：原会话或工作区不匹配。');
      }
      const job = { id: randomUUID(), agent: input.agent, prompt: input.prompt.trim(), workspace, model: input.model?.trim() || '',
        sessionId: original?.sessionId || '', parentJobId: original?.id || '', createdAt: Date.now(), updatedAt: Date.now(), status: 'starting' };
      const entry = { job, approvals: new Map(), child: null, driver: null, outcome: null, timer: null, logBuffer: '', logTimer: null };
      ledger.saveJob(job); active.set(job.id, entry); changed();
      const save = () => { job.updatedAt = Date.now(); ledger.saveJob(job); changed(); };
      const flushLog = () => { clearTimeout(entry.logTimer); entry.logTimer = null; if (entry.logBuffer) { ledger.log(job.id, redact(entry.logBuffer)); entry.logBuffer = ''; changed(); } };
      const log = (text) => { if (!text) return; entry.logBuffer += String(text); if (entry.logBuffer.length >= 7000) flushLog(); else if (!entry.logTimer) entry.logTimer = setTimeout(flushLog, 120); };
      const kill = () => {
        const child = entry.child;
        if (!child?.pid || child.exitCode !== null || !active.has(job.id)) return;
        // 仅结束本实例持有的子进程树，禁止按进程名称清理用户的其他 Agent。
        if (process.platform === 'win32') { const killer = spawnImpl(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' }); killer.on('error', () => child.kill()); }
        else child.kill('SIGTERM');
      };
      const finish = (status, error) => {
        if (!active.has(job.id) || entry.outcome) return;
        entry.outcome = job.status === 'stopping' ? 'cancelled' : status;
        if (error) { job.error = redact(error).slice(0, 2000); log(job.error); }
        entry.approvals.clear(); flushLog();
        entry.child?.stdin?.end();
        clearTimeout(entry.timer); entry.timer = setTimeout(kill, 700);
      };
      const io = {
        log, error: (error) => finish('failed', error.message || String(error)), finish,
        send(data) { if (entry.child?.stdin?.writable) entry.child.stdin.write(JSON.stringify(data) + '\n'); },
        session(id) { if (typeof id === 'string' && id.length <= 200) { job.sessionId = id; save(); } },
        running() { if (job.status !== 'stopping') { job.status = entry.approvals.size ? 'waiting' : 'running'; save(); } },
        capture(record) { ledger.capture(record); },
        approval(id, title, detail, callback) {
          if (job.status === 'stopping') { Promise.resolve(callback(false)).catch(io.error); return; }
          if (entry.approvals.has(id)) return;
          entry.approvals.set(id, { id, title: redact(title), detail: redact(JSON.stringify(detail, null, 2)).slice(0, 16000), callback });
          job.status = 'waiting'; save(); log(`等待审批：${title}`);
        },
        question(id, title, questions, callback) {
          io.approval(id, title, {}, callback);
          const approval = entry.approvals.get(id);
          if (approval && !approval.questions) {
            if (!Array.isArray(questions) || !questions.length || questions.length > 50) throw new Error('Agent 提问超出支持范围。');
            approval.questions = questions.map((q) => ({ id: String(q.id), question: redact(q.question).slice(0, 4000), detail: redact(q.detail || '').slice(0, 16000), multiSelect: Boolean(q.multiSelect), secret: Boolean(q.secret), required: q.required !== false, options: (q.options || []).slice(0, 30).map((o) => ({ label: String(o.label).slice(0, 1000), description: redact(o.description || '').slice(0, 2000) })) }));
            save();
          }
        },
        withdraw(id) { if (entry.approvals.delete(id)) io.running(); },
        syncApprovals(ids) { for (const id of entry.approvals.keys()) if (!ids.has(id)) entry.approvals.delete(id); if (job.status === 'waiting' && !entry.approvals.size) io.running(); },
      };
      entry.kill = kill;
      try {
        let args = [...runtime.prefix], env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        if (job.agent === 'codex') { args.push('app-server', '--listen', 'stdio://'); env.CODEX_HOME = homes.codex; entry.driver = codexDriver(io, job); }
        if (job.agent === 'claude') {
          args.push('-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--permission-mode', 'manual', '--permission-prompts', 'host');
          if (job.sessionId) args.push('--resume', job.sessionId);
          if (job.model) args.push('--model', job.model);
          env.CLAUDE_CONFIG_DIR = homes.claude; env.CLAUDE_CODE_SDK_READS_SESSION_STATE = '1'; delete env.CLAUDECODE; entry.driver = claudeDriver(io, job);
        }
        if (job.agent === 'dsh') {
          const bridge = await dshPatch(runtime, runtimeDir);
          args.push('--profile', 'headless', '--patch', bridge.patch);
          env.DSH_HOME = homes.dsh; env.ACC_DSH_PACKAGE = bridge.packageFile; entry.driver = dshDriver(io, job);
        }
        if (job.agent === 'opencode') {
          const port = await freePort(), secret = password();
          args.push('serve', '--hostname', '127.0.0.1', '--port', String(port));
          env.OPENCODE_SERVER_USERNAME = 'opencode'; env.OPENCODE_SERVER_PASSWORD = secret;
          // OpenCode 以 XDG 数据根目录定位自己的 opencode 子目录。
          env.XDG_DATA_HOME = path.dirname(homes.opencode);
          entry.driver = opencodeDriver(io, job, port, secret, fetchImpl);
        }
        if (job.status === 'stopping') { active.delete(job.id); job.status = 'cancelled'; save(); return job; }
        const child = spawnImpl(runtime.command, args, { cwd: workspace, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        entry.child = child;
        child.stdin.on('error', (error) => { if (!entry.outcome && job.status !== 'stopping') log(error.message); });
        const decoder = new StringDecoder('utf8'); let buffer = '';
        child.stdout.on('data', (data) => {
          buffer += decoder.write(data);
          if (buffer.length > 2 * 1024 * 1024) { io.error(new Error('Agent 输出行超出 2 MB 限制。')); buffer = ''; return; }
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            try { entry.driver.message?.(JSON.parse(line)); } catch (error) { if (!(error instanceof SyntaxError)) io.error(error); else if (job.agent === 'opencode' || job.agent === 'dsh') log(line); }
          }
        });
        const errDecoder = new StringDecoder('utf8');
        child.stderr.on('data', (data) => log(errDecoder.write(data)));
        const closed = (code, error) => {
          if (!active.has(job.id)) return;
          clearTimeout(entry.timer); entry.driver.dispose?.(); flushLog();
          job.status = job.status === 'stopping' ? 'cancelled' : entry.outcome || 'failed';
          if (!entry.outcome && job.status === 'failed') job.error = redact(error?.message || `进程已退出（${code ?? '未知'}），未收到完成事件。`);
          job.exitCode = code; entry.approvals.clear(); active.delete(job.id); save();
        };
        child.once('error', (error) => closed(null, error)); child.once('close', (code) => closed(code));
        child.once('spawn', () => { Promise.resolve(entry.driver.start()).catch(io.error); });
      } catch (error) { io.error(error); if (!entry.child) { clearTimeout(entry.timer); active.delete(job.id); job.status = 'failed'; save(); } }
      return job;
    } finally { starting.delete(input.agent); }
  }
  async function cancel(id) {
    const entry = active.get(id);
    if (!entry) throw new Error('任务未运行，或并非由当前控制中心启动。');
    entry.job.status = 'stopping'; entry.job.updatedAt = Date.now(); ledger.saveJob(entry.job); changed();
    for (const approval of entry.approvals.values()) await Promise.resolve(approval.callback(false)).catch(() => {});
    entry.approvals.clear();
    Promise.resolve(entry.driver?.cancel()).catch(() => {});
    clearTimeout(entry.timer); entry.timer = setTimeout(() => entry.kill?.(), 4000);
  }
  return { start, jobs, cancel, activeCount: () => active.size,
    async approve(jobId, approvalId, allow, answers) {
      if (typeof allow !== 'boolean') throw new Error('无效审批决定。');
      const entry = active.get(jobId), approval = entry?.approvals.get(approvalId);
      if (!approval) throw new Error('审批请求已失效，请刷新。');
      if (approval.questions && allow) {
        if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('请回答问题后提交。');
        for (const question of approval.questions) {
          const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : null;
          if (!answer || !Array.isArray(answer.selected) || answer.selected.some((value) => !question.options.some((option) => option.label === value)) || typeof answer.custom !== 'string' || answer.custom.length > 4000 || (!question.multiSelect && answer.selected.length > 1) || (question.required && !answer.selected.length && !answer.custom.trim())) throw new Error('请填写有效的答案。');
        }
      }
      await approval.callback(allow, answers); entry.approvals.delete(approvalId);
      if (entry.job.status !== 'stopping') entry.job.status = entry.approvals.size ? 'waiting' : 'running';
      ledger.log(jobId, `用户${allow ? '允许本次' : '拒绝'}：${approval.title}`); ledger.saveJob(entry.job); changed();
    },
    async stopAll() {
      for (const id of active.keys()) await cancel(id).catch(() => {});
      await new Promise((resolve) => { const timer = setInterval(() => { if (!active.size) { clearInterval(timer); clearTimeout(limit); resolve(); } }, 100); const limit = setTimeout(() => { clearInterval(timer); resolve(); }, 8000); });
      if (active.size) throw new Error('部分任务进程未能退出，请在任务页重试取消，确认停止后再退出。');
    },
  };
}
module.exports = { createTaskManager, redact };
