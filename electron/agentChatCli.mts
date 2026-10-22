import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { decodeRuntimeEvent, solutionSelectionQuestions, type RuntimeEvent, type SolutionQuestionAnswer } from '@cardbush/bush-protocol';
import { AgentHttpClient, AgentNetworkError, agentBaseUrl } from './agentHttpClient.mjs';
import { writePrivateJson } from './atomicJsonFile.mjs';
import type { AgentJob, AgentProject, AgentSendInput } from './agentTypes.js';

type Client = Pick<AgentHttpClient, 'call' | 'events'>;
type Job = Pick<AgentJob, 'id' | 'sessionId' | 'turnId'>;
type Interaction = Extract<RuntimeEvent, { kind: 'permission_requested' | 'solution_selection_requested' }>;
export interface ChatTerminal {
  write(text: string): void;
  status(text: string): void;
  ask(prompt: string, signal: AbortSignal): Promise<string | null>;
  interactive: boolean;
}

// Model/tool strings are terminal data, never cursor, title or clipboard commands.
export function terminalText(text: string) {
  return stripVTControlCharacters(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

// Only this CLI-owned decoration may emit ANSI; server/model text is sanitized.
export function resumeHint(sessionId: string, color: boolean) {
  const id = terminalText(sessionId);
  return `\n继续此会话：cardbush resume ${color ? `\x1b[34m${id}\x1b[0m` : id}\n`;
}

type SavedConnection = { url: string; tokenFile: string; agentId: string };
async function readConnection(file: string): Promise<SavedConnection | undefined> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const value = JSON.parse(text) as SavedConnection;
  if (!value || typeof value.url !== 'string' || typeof value.tokenFile !== 'string' || typeof value.agentId !== 'string') {
    throw new Error(`CLI 连接配置无效：${file}`);
  }
  return value;
}

async function answerInteraction(client: Client, event: Interaction, io: ChatTerminal, signal: AbortSignal) {
  // Replaying a running task must not ask again for a decision already answered
  // in the desktop or another terminal. The host remains the authority on races.
  if (event.kind === 'permission_requested') {
    const later = await client.call('runtime.command', { kind: 'runtime.list_turn_events', payload: {
      sessionId: event.sessionId, turnId: event.turnId, afterSequence: event.sequence,
    } }, signal) as RuntimeEvent[];
    if (later.some(item => ['permission_answered', 'permission_rejected', 'permission_expired', 'permission_cancelled'].includes(item.kind)
      && 'permissionId' in item.payload && item.payload.permissionId === event.payload.permissionId)) return;
  } else {
    const pending = await client.call('runtime.command', { kind: 'runtime.list_solution_selections', payload: { sessionId: event.sessionId } }, signal) as Array<{ selectionId: string }>;
    if (!pending.some(item => item.selectionId === event.payload.selectionId)) return;
  }
  if (!io.interactive) throw Object.assign(new Error('此任务需要交互确认。请在终端使用 cardbush resume 恢复会话；本次任务已停止。'), { exitCode: 2 });
  if (event.kind === 'permission_requested') {
    const request = event.payload;
    io.status(`\n需要批准：${request.reason}\n${request.actions.join(', ')}\n${request.targets.map(target => `${target.kind}: ${target.value}`).join('\n')}\n`);
    const answer = await io.ask('仅允许本次？输入 y 允许，其他输入拒绝 [y/N]: ', signal);
    signal.throwIfAborted();
    if (answer === null) throw Object.assign(new Error('输入已关闭；任务已停止。'), { exitCode: 2 });
    const allow = answer.trim().toLowerCase() === 'y';
    await client.call('runtime.command', { kind: 'runtime.answer_permission', payload: {
      protocol: 'bush.runtime_permission_answer.v1', permissionId: request.permissionId, answerId: randomUUID(),
      decision: allow ? 'allow_once' : 'deny', grantedCapabilityIds: allow ? request.requestedCapabilityIds : [],
    } }, signal);
  } else {
    const request = event.payload;
    const questions = solutionSelectionQuestions(request), answers: SolutionQuestionAnswer[] = [];
    let cancelled = false;
    for (const [position, question] of questions.entries()) {
      io.status(`\n${questions.length > 1 ? `[${position + 1}/${questions.length}] ` : ''}${question.prompt}\n${question.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}\n`);
      let answer: string | null;
      do {
        answer = await io.ask('输入序号或自己的回答（/cancel 取消全部）: ', signal);
        if (answer !== null && answer.trim().length > 8000) io.status('回答过长，请控制在 8000 字符以内。\n');
      } while (answer !== null && (!answer.trim() || answer.trim().length > 8000) && !signal.aborted);
      signal.throwIfAborted();
      if (answer === null) throw Object.assign(new Error('输入已关闭；任务已停止。'), { exitCode: 2 });
      const value = answer.trim(), index = /^[1-3]$/.test(value) ? Number(value) - 1 : -1;
      if (value === '/cancel') { cancelled = true; break; }
      answers.push(index >= 0 && index < question.options.length
        ? { questionId: question.id, kind: 'option', optionIndex: index } : { questionId: question.id, kind: 'text', text: value });
    }
    const { questionId: _, ...single } = answers[0] ?? {};
    await client.call('runtime.command', { kind: 'runtime.answer_solution_selection', payload: {
      selectionId: request.selectionId, sessionId: request.sessionId, turnId: request.turnId,
      ...(cancelled ? { kind: 'cancel' } : request.questions ? { kind: 'answers', answers } : single),
    } }, signal);
  }
}

/** Observe a durable Agent job. Reconnect by event cursor; never resubmit work. */
export async function followAgentTurn(client: Client, job: Job, io: ChatTerminal, signal: AbortSignal): Promise<number> {
  let cursor: number | undefined, retries = 0, ended = false, outputOpen = false;
  const segments = new Map<string, string>();
  const lineBreak = () => { if (outputOpen) { io.write('\n'); outputOpen = false; } };
  try {
    while (!ended) {
      signal.throwIfAborted();
      let interaction: Interaction | undefined;
      try {
        for await (const frame of client.events({ sessionId: job.sessionId, turnId: job.turnId, afterSequence: cursor }, signal)) {
          if (frame.type === 'end') { ended = true; break; }
          if (frame.type !== 'event') continue;
          const event = decodeRuntimeEvent(frame.event); cursor = event.sequence; retries = 0;
          if (event.kind === 'assistant_segment_delta' || event.kind === 'assistant_segment_completed') {
            const previous = segments.get(event.payload.segmentId) ?? '';
            const text = event.kind === 'assistant_segment_delta' ? event.payload.delta
              : event.payload.content.startsWith(previous) ? event.payload.content.slice(previous.length) : '';
            segments.set(event.payload.segmentId, previous + text);
            if (text) { io.write(text); outputOpen = true; }
            if (event.kind === 'assistant_segment_completed') lineBreak();
          } else if (event.kind === 'tool_running') {
            lineBreak(); io.status(`[工具] ${event.payload.display?.title ?? event.payload.toolName}\n`);
          } else if (event.kind === 'tool_failed') {
            lineBreak(); io.status(`[工具失败] ${event.payload.toolName}: ${event.payload.error.message}\n`);
          } else if (event.kind === 'context_compaction_started') {
            lineBreak(); io.status('[整理上下文]\n');
          } else if (event.kind === 'replay_reset') {
            lineBreak(); io.status('[执行记录已修订，以下为后续结果]\n');
          } else if (event.kind === 'permission_requested' || event.kind === 'solution_selection_requested') {
            interaction = event; lineBreak(); break;
          }
        }
      } catch (error) {
        if (signal.aborted) throw error;
        const transient = error instanceof AgentNetworkError || error instanceof Error && /^Agent event stream (disconnected|timed out)/.test(error.message);
        if (!transient || ++retries > 3) throw error;
        io.status('[连接中断，按事件位置恢复]\n');
        await delay(250 * retries, undefined, { signal });
        continue;
      }
      // Close the HTTP iterator before waiting for a person. Heartbeat/idle
      // deadlines must not limit how long the user can read an approval prompt.
      if (interaction) await answerInteraction(client, interaction, io, signal);
    }
    // Runtime's terminal event may precede the service's durable job update.
    // Wait for that existing commit instead of treating a brief 'running' as failure.
    let result: AgentJob | undefined;
    const deadline = Date.now() + 15_000;
    for (let attempt = 0; ; attempt++) {
      const jobs = await client.call('chat.jobs', { sessionId: job.sessionId }, signal) as AgentJob[];
      result = jobs.find(item => item.id === job.id);
      if (!result || !['running', 'queued'].includes(result.status) || Date.now() >= deadline) break;
      await delay(Math.min(100 * 2 ** attempt, 1000), undefined, { signal });
    }
    if (result?.status === 'completed') return 0;
    if (result?.status === 'stopped') return 130;
    throw new Error(result?.error ?? `任务未完成：${result?.status ?? 'unknown'}`);
  } catch (error) {
    if ((error as { exitCode?: number }).exitCode === 2) await client.call('chat.stop', { id: job.id });
    throw error;
  } finally { lineBreak(); }
}

/** Standard readline on the existing terminal; no alternate screen or TUI. */
class Terminal implements ChatTerminal {
  readonly interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  #reader?: Interface;
  #waiting?: (value: string | null) => void;
  #closed = false;
  constructor(interrupt: () => void) {
    if (!this.interactive) return;
    this.#reader = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    this.#reader.on('line', line => {
      if (this.#waiting) this.#waiting(line);
      else if (line.trim()) this.status('[任务执行中，输入未提交；请等待下一次提示]\n');
    });
    this.#reader.on('close', () => { this.#closed = true; this.#waiting?.(null); interrupt(); });
    this.#reader.on('SIGINT', interrupt);
  }
  write(text: string) { process.stdout.write(terminalText(text)); }
  status(text: string) { process.stderr.write(terminalText(text)); }
  ask(prompt: string, signal: AbortSignal): Promise<string | null> {
    if (!this.#reader || this.#closed || signal.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      const finish = (value: string | null) => { this.#waiting = undefined; signal.removeEventListener('abort', abort); this.#reader?.setPrompt(''); resolve(value); };
      const abort = () => finish(null);
      this.#waiting = finish; signal.addEventListener('abort', abort, { once: true });
      // A partially typed line from execution must never become an approval.
      this.#reader!.write(null, { ctrl: true, name: 'u' });
      this.#reader!.write(null, { ctrl: true, name: 'k' });
      this.#reader!.setPrompt(prompt); this.#reader!.prompt();
    });
  }
  close() { this.#closed = true; this.#reader?.removeAllListeners('close'); this.#waiting?.(null); this.#reader?.close(); }
}

const help = `CardBush 终端对话（连接已有 Agent 服务）
用法：cardbush [选项]
      cardbush resume <会话ID> [选项]

新会话直接信任并使用当前目录；默认申请审批，--full-access 以完全访问模式启动。
首次连接：cardbush --token-file <Agent数据目录>/access-token
连接成功后记住地址与令牌文件位置；以后直接运行 cardbush。

  --url URL          服务地址，沿用上次连接；首次默认 http://127.0.0.1:4780
  --token-file PATH  访问令牌文件；也可设置 CARDBUSH_AGENT_TOKEN / CARDBUSH_AGENT_URL
  --session ID      继续已有会话；省略则创建新会话
  --project ID      新会话改用已有服务器项目，不使用当前目录
  --model ID        使用已配置模型；默认使用 Agent 默认模型
  --full-access     完全访问；仍遵守宿主强制限制和进程保护
  --permission MODE task_free（申请审批，默认）、user_free、all_free
  --prompt TEXT     执行一轮后退出；也支持将标准输入作为一条完整提示
  --models          列出模型
  --projects        列出项目
  --sessions        列出会话
  --help            显示帮助

交互命令：/new 新会话，/exit 退出，/help 帮助。其他输入（含 Skill 命令）原样发送。
Ctrl+C：执行时停止当前任务，空闲时退出。审批仅允许本次；管道模式遇到确认会停止并返回 2。
stdout 为回复，stderr 为进度/提示。原生终端滚动、选择复制和重定向均可用。
远端服务请使用 HTTPS 或已有 SSH 隧道。CLI 不创建第二个 Agent，不修改模型或插件配置。
`;

function validatePrompt(text: string) {
  if (!text.trim() || text.length > 1_000_000) throw new Error('提示不能为空，且最多 1,000,000 字符。');
  // Leave room for the request envelope below the existing HTTP 2 MiB limit.
  if (Buffer.byteLength(JSON.stringify(text)) > 2 * 1024 * 1024 - 16 * 1024) throw new Error('提示过大，请改为引用服务器上的文件。');
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean' }, url: { type: 'string' }, 'token-file': { type: 'string' }, session: { type: 'string' },
    project: { type: 'string' }, model: { type: 'string' }, prompt: { type: 'string' }, permission: { type: 'string' },
    'full-access': { type: 'boolean' },
    models: { type: 'boolean' }, projects: { type: 'boolean' }, sessions: { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(help); return 0; }
  if (positionals.length && (positionals.length !== 2 || positionals[0] !== 'resume' || !positionals[1].trim())) {
    throw new Error('用法：cardbush 或 cardbush resume <会话ID>');
  }
  if (positionals.length && values.session) throw new Error('resume 和 --session 不能同时指定。');
  const resumeId = positionals[1] ?? values.session;
  const permissionMode = values['full-access'] ? 'all_free' : values.permission ?? 'task_free';
  if (values['full-access'] && values.permission && values.permission !== 'all_free') throw new Error('--full-access 与 --permission 冲突。');
  if (!['task_free', 'user_free', 'all_free'].includes(permissionMode)) throw new Error('Invalid --permission. Use task_free, user_free or all_free.');
  if (resumeId && values.project) throw new Error('--project 仅用于新会话；恢复会话保留原工作区。');
  const connectionFile = resolve(process.env.CARDBUSH_CLI_CONFIG || join(homedir(), '.cardbush', 'cli.json'));
  const saved = await readConnection(connectionFile);
  const url = agentBaseUrl(values.url ?? (process.env.CARDBUSH_AGENT_URL || saved?.url || 'http://127.0.0.1:4780'));
  // Never reuse a saved credential for a different explicitly selected server.
  const savedForUrl = saved && agentBaseUrl(saved.url) === url ? saved : undefined;
  const tokenFile = values['token-file'] ? resolve(values['token-file']) : !process.env.CARDBUSH_AGENT_TOKEN?.trim() ? savedForUrl?.tokenFile : undefined;
  const token = (tokenFile ? await readFile(tokenFile, 'utf8') : process.env.CARDBUSH_AGENT_TOKEN ?? '').trim();
  if (!token) throw new Error('请提供 --token-file <Agent数据目录>/access-token 或 CARDBUSH_AGENT_TOKEN。');
  const client = new AgentHttpClient(url, token, !values['token-file'] && tokenFile ? savedForUrl?.agentId : undefined);
  const lifetime = new AbortController(); let turn: AbortController | undefined, active: Job | undefined, stopping: Promise<unknown> | undefined;
  let session: { sessionId: string } | undefined;
  const interrupt = () => {
    if (turn && active) {
      turn.abort();
      stopping ??= client.call('chat.stop', { id: active.id }).catch(() => undefined);
    } else { lifetime.abort(); if (!process.stdin.isTTY) process.stdin.destroy(); }
  };
  const terminate = () => { lifetime.abort(); interrupt(); };
  const io = new Terminal(interrupt);
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const info = await client.info(lifetime.signal);
    if (values['token-file']) await writePrivateJson(connectionFile, { url, tokenFile, agentId: info.id });
    if (values.sessions || values.projects) {
      const result = await client.call(values.sessions ? 'sessions.list' : 'projects.list', values.sessions ? { projection: 'summary' } : {}, lifetime.signal);
      const items = (values.sessions ? result : (result as { projects: AgentProject[] }).projects) as Array<{ sessionId?: string; id?: string; name?: string; path?: string; metadata?: { title?: string } }>;
      items.forEach(item => io.write(`${item.sessionId ?? item.id}\t${item.metadata?.title ?? item.name ?? ''}${item.path ? '\t' + item.path : ''}\n`));
      return 0;
    }
    const config = await client.call('product.command', { kind: 'models.get' }, lifetime.signal) as { defaultModelId: string; models: Array<{ id: string; modelName: string }> };
    if (values.models) { config.models.forEach(model => io.write(`${model.id}\t${model.modelName}${model.id === config.defaultModelId ? ' (default)' : ''}\n`)); return 0; }
    const modelId = values.model ?? config.defaultModelId;
    if (!config.models.some(model => model.id === modelId)) throw new Error('所选模型未配置。使用 --models 查看 Agent 模型，再传入 --model ID。');
    let prompt = values.prompt;
    if (prompt === undefined && !io.interactive) {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk); bytes += buffer.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('标准输入过大。请改为引用服务器上的文件。');
        chunks.push(buffer);
      }
      prompt = Buffer.concat(chunks).toString('utf8');
    }
    if (prompt !== undefined) validatePrompt(prompt);
    let projectId = values.project;
    const createSession = async () => {
      if (!projectId) {
        const directory = await realpath(process.cwd());
        const projects = await client.call('projects.list', {}, lifetime.signal) as { projects: AgentProject[] };
        const pathKey = (path: string) => info.platform === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path;
        let project = projects.projects.find(item => pathKey(item.path) === pathKey(directory));
        if (!project) project = await client.call('projects.save', { name: (basename(directory) || directory).slice(0, 100), path: directory }, lifetime.signal) as AgentProject;
        projectId = project.id;
      }
      return client.call('sessions.create', { projectId }, lifetime.signal) as Promise<{ sessionId: string }>;
    };
    // Read summaries rather than downloading a potentially enormous transcript.
    session = resumeId ? (await client.call('sessions.list', { projection: 'summary' }, lifetime.signal) as Array<{ sessionId: string }>).find(item => item.sessionId === resumeId) : await createSession();
    if (!session) throw new Error('找不到指定会话。');
    const identify = () => io.status(`\n${info.name} · ${modelId} · ${permissionMode === 'all_free' ? '完全访问' : '申请审批'}\n会话：${session!.sessionId}\n`);
    identify();
    const run = async (job: Job, submit?: AgentSendInput) => {
      active = job; turn = new AbortController(); stopping = undefined;
      const signal = AbortSignal.any([turn.signal, lifetime.signal]);
      try {
        if (submit) await client.call('chat.send', submit, signal);
        return await followAgentTurn(client, job, io, signal);
      } catch (error) {
        if (signal.aborted) {
          await stopping;
          // A cancelled submission may not have reached the server. Query the
          // durable job before reporting it stopped; never submit it again.
          const jobs = await client.call('chat.jobs', { sessionId: job.sessionId }) as AgentJob[];
          if (jobs.some(item => item.id === job.id)) {
            await client.call('chat.stop', { id: job.id }); io.status('\n[当前任务已请求停止]\n');
          } else io.status(`\n[已取消本地等待，服务端尚未发现任务 ${job.id}；请用 cardbush resume ${job.sessionId} 核对提交结果]\n`);
          return 130;
        }
        io.status(`\n任务 ${job.id}；恢复时读取原任务，不会自动重新提交。\n`); throw error;
      } finally { await stopping; active = undefined; turn = undefined; }
    };
    const existing = (await client.call('chat.jobs', { sessionId: session.sessionId }, lifetime.signal) as AgentJob[]).filter(job => ['running', 'queued'].includes(job.status));
    if (existing.length && prompt !== undefined) throw new Error('该会话已有任务，请先用 cardbush resume 交互恢复；未提交新的提示。');
    for (const job of existing) { await run(job); if (lifetime.signal.aborted) return 130; }
    while (!lifetime.signal.aborted) {
      const text = prompt ?? await io.ask('\n你> ', lifetime.signal);
      if (text === null) break;
      if (prompt === undefined && text.trim() === '/exit') break;
      if (prompt === undefined && text.trim() === '/help') { io.status(help); continue; }
      if (prompt === undefined && text.trim() === '/new') { session = await createSession(); identify(); continue; }
      if (!text.trim()) continue;
      validatePrompt(text);
      const job = { id: randomUUID(), sessionId: session.sessionId, turnId: `turn-${randomUUID()}` };
      const result = await run(job, { requestId: job.id, sessionId: job.sessionId, turnId: job.turnId, text, modelId,
        permissionMode: permissionMode as AgentSendInput['permissionMode'], language: 'zh' });
      if (prompt !== undefined) return result;
    }
    return lifetime.signal.aborted ? 130 : 0;
  } catch (error) {
    if (lifetime.signal.aborted) return 130;
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    io.close(); client.close();
    if (session) process.stderr.write(resumeHint(session.sessionId, Boolean(process.stderr.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb')));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(terminalText(error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = typeof error?.exitCode === 'number' ? error.exitCode : 1;
  });
}
