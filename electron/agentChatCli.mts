import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeRuntimeEvent, solutionSelectionQuestions, taskPlanSchema, type TaskPlan, type RuntimeEvent, type SolutionQuestionAnswer } from '@cardbush/bush-protocol';
import { AgentHttpClient, AgentNetworkError, agentBaseUrl } from './agentHttpClient.mjs';
import { writePrivateJson } from './atomicJsonFile.mjs';
import type { AgentJob, AgentProject, AgentSendInput } from './agentTypes.js';
import type { ChatClient } from './agentLocalChat.mjs';
import { readChatModels, selectChatModel, waitForChatConfiguration } from './agentChatModels.mjs';
import { NativeChatTerminal } from './agentChatTerminal.mjs';
import { terminalText } from './agentChatPresentation.mjs';
import { AgentChatCompletion, isChatExitCommand, type ChatInputOptions } from './agentChatCompletion.mjs';
import { AgentChatReferences, openChatArtifact } from './agentChatReferences.mjs';
import { chatShellCommand, executeChatShell, type runChatShell } from './agentChatShell.mjs';
export { terminalText } from './agentChatPresentation.mjs';

type Client = Pick<AgentHttpClient, 'call' | 'events'>;
type Job = Pick<AgentJob, 'id' | 'sessionId' | 'turnId'>;
type ChatSession = { sessionId: string; metadata?: { projectDir?: string | null; runtimeWorkspace?: { workspaceDir?: string } } };
type Interaction = Extract<RuntimeEvent, { kind: 'permission_requested' | 'solution_selection_requested' }>;
const pendingJob = (job: AgentJob) => job.status === 'running' || job.status === 'queued';
export interface ChatTerminal {
  write(text: string): void;
  status(text: string): void;
  ask(prompt: string, signal: AbortSignal, options?: boolean | ChatInputOptions): Promise<string | null>;
  interactive: boolean;
  event?(event: RuntimeEvent): void;
  plan?(plan: TaskPlan | null, detailed?: boolean): void;
  suspendInput?(): () => void;
  runShell?(command: string, cwd: string, signal: AbortSignal): Promise<number>;
}

// Only this CLI-owned decoration may emit ANSI; server/model text is sanitized.
export function resumeHint(sessionId: string, color: boolean, local = false) {
  const id = terminalText(sessionId);
  return `\nResume this session: cardbush --resume ${color ? `\x1b[34m${id}\x1b[0m` : id}${local ? ' --local' : ''}\n`;
}

async function waitForAgentJob(client: Client, job: Job, signal?: AbortSignal): Promise<AgentJob | undefined> {
  const deadline = Date.now() + 15_000;
  for (let attempt = 0; ; attempt++) {
    const jobs = await client.call('chat.jobs', { sessionId: job.sessionId }, signal) as AgentJob[];
    const result = jobs.find(item => item.id === job.id && item.sessionId === job.sessionId);
    if (!result || !pendingJob(result) || Date.now() >= deadline) return result;
    await delay(Math.min(100 * 2 ** attempt, 1000), undefined, { signal });
  }
}

/** A service can start the next queued job before this observer finishes the
 * preceding one. Resolve the stop against durable state and this CLI's own
 * submissions, then wait for settlement without cancelling the confirmation. */
export async function stopAgentTurn(client: Client, job: Job, io: Pick<ChatTerminal, 'status'>,
  submitted: ReadonlySet<string> = new Set()): Promise<AgentJob | undefined> {
  const signal = AbortSignal.timeout(15_000);
  try {
    const jobs = (await client.call('chat.jobs', { sessionId: job.sessionId }, signal) as AgentJob[])
      .filter(item => item.sessionId === job.sessionId);
    const observed = jobs.find(item => item.id === job.id);
    const target = observed && pendingJob(observed) ? observed
      : jobs.find(item => submitted.has(item.id) && item.status === 'running')
        ?? jobs.find(item => submitted.has(item.id) && item.status === 'queued' && !item.guidance);
    if (!target) {
      if (!observed) throw new Error('The task was not found on the Agent.');
      return observed;
    }
    const receipt = await client.call('chat.stop', { id: target.id }, signal) as { accepted?: boolean };
    if (!receipt?.accepted) throw new Error('The Agent did not accept the stop request.');
    io.status('\n[Stop requested for the current task]\n');
    const settled = await waitForAgentJob(client, target, signal);
    if (!settled || pendingJob(settled)) throw new Error('The task has not reached a terminal state.');
    // Finish the observed task truthfully; a newly stopped queued task is still
    // observed by the normal loop so its partial response is not discarded.
    return target.id === job.id ? settled : observed;
  } catch (error) {
    throw new Error(`Stop could not be confirmed. Resume session ${job.sessionId} to check the task. ${
      signal.aborted ? 'Confirmation timed out.' : error instanceof Error ? error.message : String(error)}`);
  }
}

type SavedConnection = { url: string; tokenFile: string; agentId: string };
async function readConnection(file: string): Promise<SavedConnection | undefined> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const value = JSON.parse(text) as SavedConnection;
  if (!value || typeof value.url !== 'string' || typeof value.tokenFile !== 'string' || typeof value.agentId !== 'string') {
    throw new Error(`Invalid CLI connection configuration: ${file}`);
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
  if (!io.interactive) throw Object.assign(new Error('This task needs interactive confirmation and has been stopped. Run cardbush --resume in a terminal to continue.'), { exitCode: 2 });
  if (event.kind === 'permission_requested') {
    const request = event.payload;
    io.status(`\nApproval required: ${request.reason}\n${request.actions.join(', ')}\n${request.targets.map(target => `${target.kind}: ${target.value}`).join('\n')}\n`);
    const answer = await io.ask('Allow once? Type y to allow, anything else to deny [y/N]: ', signal,
      { choices: [{ value: 'n', description: 'Deny' }, { value: 'y', description: 'Allow once' }] });
    signal.throwIfAborted();
    if (answer === null) throw Object.assign(new Error('Input closed; task stopped.'), { exitCode: 2 });
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
        answer = await io.ask('Enter a number or your own answer (/cancel to cancel all): ', signal,
          { choices: [...question.options.map((option, index) => ({ value: String(index + 1), label: `${index + 1}. ${option}` })), { value: '/cancel', description: 'Cancel all' }] });
        if (answer !== null && answer.trim().length > 8000) io.status('Answer too long. Use at most 8,000 characters.\n');
      } while (answer !== null && (!answer.trim() || answer.trim().length > 8000) && !signal.aborted);
      signal.throwIfAborted();
      if (answer === null) throw Object.assign(new Error('Input closed; task stopped.'), { exitCode: 2 });
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
          const event = decodeRuntimeEvent(frame.event);
          if (event.sessionId !== job.sessionId || event.turnId !== job.turnId) continue;
          if (cursor !== undefined && event.sequence <= cursor) continue;
          cursor = event.sequence; retries = 0;
          if (event.kind === 'assistant_segment_delta' || event.kind === 'assistant_segment_completed') {
            const key = `${event.payload.messageId}\0${event.payload.segmentId}`;
            const previous = segments.get(key) ?? '';
            const text = event.kind === 'assistant_segment_delta' ? event.payload.delta
              : event.payload.content.startsWith(previous) ? event.payload.content.slice(previous.length) : event.payload.content;
            if (event.kind === 'assistant_segment_completed' && previous && !event.payload.content.startsWith(previous)) {
              lineBreak(); io.status('[Response revised]\n');
            }
            segments.set(key, event.kind === 'assistant_segment_completed' ? event.payload.content : previous + text);
            if (text) { io.write(text); outputOpen = true; }
            if (event.kind === 'assistant_segment_completed') { lineBreak(); io.event?.(event); }
          } else if (event.kind === 'tool_running' || event.kind === 'tool_returned' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled') {
            lineBreak();
            if (io.event) io.event(event);
            else if (event.kind === 'tool_running') io.status(`[Tool] ${event.payload.display?.title ?? event.payload.toolName}\n`);
            else if (event.kind === 'tool_failed' || event.kind === 'tool_returned' && event.payload.resultError) io.status(`[Tool failed] ${event.payload.toolName}: ${event.kind === 'tool_failed' ? event.payload.error.message : event.payload.resultError!.message}\n`);
            if (io.plan && event.kind === 'tool_returned' && !event.payload.resultError && event.payload.toolName === 'update_task_plan') {
              // Same host plan used by the App; a failed read cannot turn a tool
              // completion into a failed task or resubmit the operation.
              const plan = await client.call('runtime.command', { kind: 'runtime.get_plan', payload: { sessionId: job.sessionId } }, signal).catch(() => null);
              const parsed = taskPlanSchema.safeParse(plan); if (parsed.success) io.plan(parsed.data);
            }
          } else if (event.kind === 'context_compaction_started') {
            lineBreak(); if (io.event) io.event(event); else io.status('[Compacting context]\n');
          } else if (event.kind === 'replay_reset') {
            lineBreak(); segments.clear(); io.status('[Execution history revised; continuing below]\n');
          } else if (event.kind === 'permission_requested' || event.kind === 'solution_selection_requested') {
            interaction = event; lineBreak(); break;
          } else io.event?.(event);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        const transient = error instanceof AgentNetworkError || error instanceof Error && /^Agent event stream (disconnected|timed out)/.test(error.message);
        if (!transient || ++retries > 3) throw error;
        io.status('[Disconnected; resuming from the last event]\n');
        await delay(250 * retries, undefined, { signal });
        continue;
      }
      // Close the HTTP iterator before waiting for a person. Heartbeat/idle
      // deadlines must not limit how long the user can read an approval prompt.
      if (interaction) {
        const resume = io.suspendInput?.();
        try { await answerInteraction(client, interaction, io, signal); }
        finally { resume?.(); }
      }
    }
    // Runtime's terminal event may precede the service's durable job update.
    // Wait for that existing commit instead of treating a brief 'running' as failure.
    const result = await waitForAgentJob(client, job, signal);
    if (result?.status === 'completed') return 0;
    if (result?.status === 'stopped') return 130;
    throw new Error(result?.error ?? `Task did not complete: ${result?.status ?? 'unknown'}`);
  } catch (error) {
    if ((error as { exitCode?: number }).exitCode === 2) await client.call('chat.stop', { id: job.id });
    throw error;
  } finally { lineBreak(); }
}

const help = `CardBush CLI (runs locally by default, or connects to an existing Agent)
Usage: cardbush [options]
       cardbush --resume <session-id> [options]

New sessions trust and use the current directory. Approval mode is the default;
use --full-access to start with full access.
Local mode needs no token and shares the App's model, plugin, MCP, network and
sandbox JSON settings. Sessions are stored in ~/.cardbush/cli-agent.
ChatGPT account models reuse App sign-in; keep the App running. API-key models
can run independently.
If no model is configured, the CLI shows the config path and an annotated example.
Edit and save the file, then press Enter to continue.
First remote connection: cardbush --url <url> --token-file <path>.
Successful connections are remembered.

  --local           Use the local runtime; ignore saved and environment connections
  --url URL         Agent URL; reuse the last connection (default: http://127.0.0.1:4780)
  --token-file PATH Access token file; or set CARDBUSH_AGENT_TOKEN / CARDBUSH_AGENT_URL
  --resume ID       Resume an existing session; otherwise create a new one
  --project ID      Use an existing server project instead of the current directory
  --model ID        Use a configured model; otherwise use the Agent's default
  --full-access     Full access; host restrictions and process protection still apply
  --permission MODE task_free (approval, default), user_free, or all_free
  --prompt TEXT     Run one turn and exit; piped stdin is also accepted as one prompt
  --models          List models
  --projects        List projects
  --sessions        List sessions
  --help            Show help

Commands: /model [ID] selects a model; /settings shows config paths and reloads settings.
          /new starts a session; /plan shows the plan; /logs shows the log path;
          /artifact [number] opens this turn's files; /source [number] shows evidence;
          /quit (or /exit) exits; /help shows help. Other input is sent to the Agent.
          /shell [COMMAND] or !COMMAND runs in this local terminal; exit returns to chat.
Use /artifact, then Tab to choose a file and Enter to open it. Esc clears the selection.
Web and local file links are clickable in supported terminals. Remote files are
downloaded only when explicitly opened; source details come from the Agent's records.
While running, Enter queues the next turn; /steer TEXT guides the current task.
The live input keeps drafts while responses stream. Approval prompts temporarily
take over input and restore the draft afterwards. Esc / Ctrl+C stops the current task.
Type / for command and Skill suggestions. Use @ for workspace files and folders;
quote paths with spaces, e.g. @"folder/file name.txt".
Slash commands prefer exact names and prefixes, then ordered fuzzy matches.
Enter confirms the selected command (e.g. /q selects /quit); Tab only fills it.
Up/Down selects a suggestion, or browses history without suggestions.
Arguments, paths, model choices and confirmation prompts support Tab. It never submits.
Enter on a file suggestion inserts it into the draft before sending.
In /settings or model setup, type vim FILE (or another command) to edit in place.
Shell commands run locally as the CLI user, even when connected to a remote Agent.
Long or multiline pastes are folded; Enter submits the complete text.
Esc stops the running task or clears a draft. Ctrl+C stops the task or exits when idle.
Approvals apply once. Piped mode stops with exit code 2 if confirmation is required.
Responses go to stdout; progress and prompts go to stderr. Native scrollback, selection,
copy and redirection remain available. Model responses follow the user's language.
Local diagnostic logs rotate in logs/runtime.log under the CLI data directory.
For remote Agents, use HTTPS or an existing SSH tunnel. Local mode needs no HTTP
service and does not copy model credentials.
`;

function validatePrompt(text: string) {
  if (!text.trim() || text.length > 1_000_000) throw new Error('Prompt must not be empty and must contain at most 1,000,000 characters.');
  // Leave room for the request envelope below the existing HTTP 2 MiB limit.
  if (Buffer.byteLength(JSON.stringify(text)) > 2 * 1024 * 1024 - 16 * 1024) throw new Error('Prompt too large. Reference a file on the Agent instead.');
}

export async function main(args = process.argv.slice(2), options: { openArtifact?: typeof openChatArtifact; shell?: typeof runChatShell } = {}): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean' }, url: { type: 'string' }, 'token-file': { type: 'string' }, session: { type: 'string' }, resume: { type: 'string' },
    project: { type: 'string' }, model: { type: 'string' }, prompt: { type: 'string' }, permission: { type: 'string' },
    'full-access': { type: 'boolean' }, local: { type: 'boolean' },
    models: { type: 'boolean' }, projects: { type: 'boolean' }, sessions: { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(help); return 0; }
  if (positionals.length && (positionals.length !== 2 || positionals[0] !== 'resume' || !positionals[1].trim())) {
    throw new Error('Usage: cardbush or cardbush --resume <session-id>');
  }
  // Keep saved scripts compatible, while all documented/generated commands use
  // the normal option spelling. Conflicting forms must never pick a session silently.
  if ([positionals[1], values.session, values.resume].filter(value => value !== undefined).length > 1) throw new Error('Use only one of --resume, --session, or the legacy resume command.');
  const resumeId = values.resume ?? positionals[1] ?? values.session;
  if (resumeId !== undefined && !resumeId.trim()) throw new Error('--resume requires a session ID.');
  const permissionMode = values['full-access'] ? 'all_free' : values.permission ?? 'task_free';
  if (values['full-access'] && values.permission && values.permission !== 'all_free') throw new Error('--full-access conflicts with --permission.');
  if (!['task_free', 'user_free', 'all_free'].includes(permissionMode)) throw new Error('Invalid --permission. Use task_free, user_free or all_free.');
  if (resumeId && values.project) throw new Error('--project applies only to new sessions; resumed sessions keep their workspace.');
  if (values.local && (values.url || values['token-file'])) throw new Error('--local cannot be combined with --url or --token-file.');
  const connectionFile = resolve(process.env.CARDBUSH_CLI_CONFIG || join(homedir(), '.cardbush', 'cli.json'));
  const saved = values.local ? undefined : await readConnection(connectionFile);
  const local = values.local || !(values.url || values['token-file'] || process.env.CARDBUSH_AGENT_URL || process.env.CARDBUSH_AGENT_TOKEN?.trim() || saved);
  const url = local ? undefined : agentBaseUrl(values.url ?? (process.env.CARDBUSH_AGENT_URL || saved?.url || 'http://127.0.0.1:4780'));
  // Never reuse a saved credential for a different explicitly selected server.
  const savedForUrl = saved && agentBaseUrl(saved.url) === url ? saved : undefined;
  const tokenFile = values['token-file'] ? resolve(values['token-file']) : !process.env.CARDBUSH_AGENT_TOKEN?.trim() ? savedForUrl?.tokenFile : undefined;
  const token = local ? '' : (tokenFile ? await readFile(tokenFile, 'utf8') : process.env.CARDBUSH_AGENT_TOKEN ?? '').trim();
  if (!local && !token) throw new Error('Remote connections require --token-file <Agent-data-dir>/access-token or CARDBUSH_AGENT_TOKEN. Use cardbush --local to run locally.');
  const client: ChatClient = local ? await (await import('./agentLocalChat.mjs')).openLocalChatClient()
    : new AgentHttpClient(url!, token, !values['token-file'] && tokenFile ? savedForUrl?.agentId : undefined);
  const lifetime = new AbortController(); let turn: AbortController | undefined, active: Job | undefined, stopping: Promise<AgentJob | undefined> | undefined;
  const queued = new Set<string>();
  const uncertain = new Map<string, { input: AgentSendInput; turnId?: string }>();
  const stopCurrent = (job: Job) => stopAgentTurn(client, job, io, new Set([...queued, ...[...uncertain.values()].map(entry => entry.input.requestId)]));
  let session: ChatSession | undefined;
  const interrupt = () => {
    if (io.runningShell) return; // The foreground native application owns Ctrl+C.
    if (active && (turn || queued.size)) {
      // Keep ownership during the observer handoff: the service can already
      // be running our next queued task while the CLI fetches its state.
      turn?.abort();
      stopping ??= stopCurrent(active);
      // The observer consumes this rejection after its event iterator closes.
      void stopping.catch(() => undefined);
    } else { lifetime.abort(); if (!process.stdin.isTTY) process.stdin.destroy(); }
  };
  const terminate = () => { lifetime.abort(); interrupt(); };
  const io = new NativeChatTerminal(interrupt, { shell: options.shell });
  let completion: AgentChatCompletion | undefined;
  let diagnosticWarningShown = false;
  const reportDiagnosticError = () => {
    if (client.diagnostics?.error && !diagnosticWarningShown) {
      io.status(`\n[Cannot write diagnostic log: ${client.diagnostics.error}] ${client.diagnostics.path}\n`);
      diagnosticWarningShown = true;
    }
  };
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
    const initialConfig = await readChatModels(client, io, lifetime.signal);
    if (!initialConfig) return lifetime.signal.aborted ? 130 : 0;
    let config = initialConfig;
    if (values.models) { config.models.forEach(model => io.write(`${model.id}\t${model.modelName}${model.id === config.defaultModelId ? ' (default)' : ''}\n`)); return 0; }
    let modelId = values.model ?? config.defaultModelId, selectedModel = Boolean(values.model);
    if (!config.models.some(model => model.id === modelId)) throw new Error(local
      ? `Selected model not found. Run cardbush --models or edit: ${client.modelConfigurationPath}`
      : 'Selected model is not configured. Use --models to list Agent models, then pass --model ID.');
    let prompt = values.prompt;
    if (prompt === undefined && !io.interactive) {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk); bytes += buffer.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('Standard input too large. Reference a file on the Agent instead.');
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
      return client.call('sessions.create', { projectId }, lifetime.signal) as Promise<ChatSession>;
    };
    // Read summaries rather than downloading a potentially enormous transcript.
    session = resumeId ? (await client.call('sessions.list', { projection: 'summary' }, lifetime.signal) as ChatSession[]).find(item => item.sessionId === resumeId) : await createSession();
    if (!session) throw new Error('Session not found.');
    const references = new AgentChatReferences(client, io, options.openArtifact);
    io.setReferenceRenderer(references);
    let referenceTurn: string | undefined;
    const referenceScope = () => references.setScope({ sessionId: session!.sessionId, turnId: referenceTurn,
      workspace: session!.metadata?.runtimeWorkspace?.workspaceDir ?? session!.metadata?.projectDir ?? undefined,
      platform: info.platform, local, hyperlinks: io.hyperlinks });
    const identify = () => {
      const modelName = config.models.find(model => model.id === modelId)?.modelName ?? modelId;
      const workspace = session!.metadata?.runtimeWorkspace?.workspaceDir ?? session!.metadata?.projectDir;
      const context = { sessionId: session!.sessionId, workspace: workspace ?? undefined, platform: info.platform, models: config.models };
      if (completion) completion.update(context);
      else { completion = new AgentChatCompletion(client, context); io.setSuggestionSource(async (line, cursor, signal) => references.suggest(line, cursor) ?? completion!.suggest(line, cursor, signal)); }
      referenceScope();
      io.identify({ name: info.name, model: modelName, permission: permissionMode === 'all_free' ? 'Full access' : 'Approval mode', workspace: workspace ?? undefined, sessionId: session!.sessionId, local }, config.models.map(model => model.id));
    };
    identify();
    let inputWork: Promise<void> = Promise.resolve(), exitRequested = false, waitingSubmissions = 0;
    const observed = new Set<string>();
    const readPlan = async () => {
      const parsed = taskPlanSchema.safeParse(await client.call('runtime.command', { kind: 'runtime.get_plan', payload: { sessionId: session!.sessionId } }, lifetime.signal));
      io.plan(parsed.success ? parsed.data : null, true);
    };
    const showLogs = () => io.status(client.diagnostics ? `Diagnostic log: ${client.diagnostics.path}\n` : 'Connected to a remote Agent; diagnostic logs are on the server.\n');
    const referenceCommand = async (text: string) => {
      const match = /^\s*\/(artifact|source)(?:\s+(.*))?\s*$/s.exec(text);
      if (!match) return false;
      io.commitInput(text);
      try { await references.handle(match[1] as 'artifact' | 'source', match[2] ?? '', lifetime.signal); }
      catch (error) { io.status(`[Unavailable] ${error instanceof Error ? error.message : 'Cannot open this reference'}\n`); }
      return true;
    };
    const queueRunningInput = (text: string) => {
      if (isChatExitCommand(text)) { io.commitInput(text); exitRequested = true; interrupt(); return; }
      const retry = uncertain.get(text);
      const target = active ?? (retry ? { id: retry.input.requestId, sessionId: retry.input.sessionId, turnId: retry.turnId ?? retry.input.turnId! } : undefined);
      if (!target || !text.trim()) return;
      if (waitingSubmissions >= 32) { io.status('[Not sent] Submission queue is full. Use input history to retry.\n'); return; }
      waitingSubmissions++;
      inputWork = inputWork.then(async () => {
        const command = text.trim();
        if (await referenceCommand(text)) return;
        if (command === '/help') { io.commitInput(text); io.status(help); return; }
        if (command === '/logs') { io.commitInput(text); showLogs(); return; }
        if (command === '/plan') { io.commitInput(text); await readPlan(); return; }
        if (/^\/(?:model|settings|new)(?:\s|$)/.test(command) || chatShellCommand(text) !== undefined) {
          io.commitInput(text);
          io.status('[Not sent] Use this command after the current task finishes, or stop it with Esc.\n'); return;
        }
        const steer = /^\/steer(?:\s|$)/.test(command), content = steer ? command.slice('/steer'.length).trim() : text;
        if (!content) { io.commitInput(text); io.status('Usage: /steer TEXT\n'); io.restoreDraft('/steer '); return; }
        validatePrompt(content);
        let entry = uncertain.get(text);
        if (!entry) {
          const prepared = await completion!.prepare(content, lifetime.signal);
          entry = { input: { requestId: randomUUID(), turnId: `turn-${randomUUID()}`, sessionId: target.sessionId,
            ...prepared, modelId, permissionMode: permissionMode as AgentSendInput['permissionMode'], language: 'en',
            ...(steer ? { queueOnly: true } : {}) }, ...(steer ? { turnId: target.turnId } : {}) };
          uncertain.set(text, entry);
        }
        let submitted: AgentJob;
        try { submitted = await client.call('chat.send', entry.input, lifetime.signal) as AgentJob; }
        catch (error) {
          // A lost receipt may still represent a committed job. Keep its exact
          // request ID and parameters for a deliberate retry; never resubmit new work.
          const jobs = await client.call('chat.jobs', { sessionId: target.sessionId }, lifetime.signal).catch(() => []) as AgentJob[];
          const existing = jobs.find(item => item.id === entry!.input.requestId);
          if (!existing) throw error;
          submitted = existing;
        }
        queued.add(submitted.id);
        if (entry.turnId) {
          io.commitInput(text);
          const messageId = `queued-guidance-${submitted.id}`;
          io.trackGuidance(messageId);
          try { await client.call('chat.queue', { action: 'guide', id: submitted.id, turnId: entry.turnId, mode: 'interrupt_and_continue' }, lifetime.signal); }
          catch (error) {
            const jobs = await client.call('chat.jobs', { sessionId: target.sessionId }, lifetime.signal) as AgentJob[];
            const current = jobs.find(item => item.id === submitted.id);
            // If the old turn ended before delivery, the SAME queued job may
            // already have started. Observe it instead of creating a second one.
            if (!current || current.status === 'queued' && !current.guidance?.applied) throw error;
          }
          const jobs = await client.call('chat.jobs', { sessionId: target.sessionId }, lifetime.signal) as AgentJob[];
          const current = jobs.find(item => item.id === submitted.id);
          if (current?.guidance?.applied) { queued.delete(submitted.id); io.guidanceQueued(messageId); }
          else { io.forgetGuidance(messageId); io.status('[Queued] The previous task ended; this message will run as the next turn.\n'); }
        }
        uncertain.delete(text); io.setQueued(queued.size);
      }).catch(error => {
        io.status(`[Failed] ${error instanceof Error ? error.message : 'Message submission failed'}. Re-enter the same message to retry its original request.\n`);
        io.restoreDraft(text);
      }).finally(() => { waitingSubmissions--; });
    };
    if (prompt === undefined) io.enableLiveInput(queueRunningInput);
    const run = async (job: Job & { text?: string }, submit?: AgentSendInput) => {
      await stopping;
      observed.add(job.id); queued.delete(job.id); io.setQueued(queued.size);
      active = job; turn = new AbortController(); stopping = undefined;
      const signal = AbortSignal.any([turn.signal, lifetime.signal]);
      let outcome: 'completed' | 'stopped' | 'failed' = 'failed';
      referenceTurn = job.turnId; referenceScope();
      io.beginTurn(job.text);
      try {
        if (submit) await client.call('chat.send', submit, signal);
        const result = await followAgentTurn(client, job, io, signal);
        outcome = result === 0 ? 'completed' : 'stopped'; return result;
      } catch (error) {
        if (signal.aborted) {
          const settled = await (stopping ??= stopCurrent(job));
          if (settled?.status === 'completed') { outcome = 'completed'; return 0; }
          if (settled?.status === 'stopped') { outcome = 'stopped'; return 130; }
          throw new Error(settled?.error ?? 'The task has not reached a terminal state.');
        }
        io.status(`\nTask ${job.id}; resuming observes this task without resubmitting it.\n`); throw error;
      } finally {
        try {
          let pending: Promise<void>;
          do { pending = inputWork; await pending; } while (pending !== inputWork);
          await stopping;
        } finally { io.finishTurn(outcome); turn = undefined; }
      }
    };
    const previousJobs = await client.call('chat.jobs', { sessionId: session.sessionId }, lifetime.signal) as AgentJob[];
    const existing = previousJobs.filter(job => ['running', 'queued'].includes(job.status));
    if (!existing.length && previousJobs.length) { referenceTurn = previousJobs.at(-1)!.turnId; referenceScope(); }
    if (existing.length && prompt !== undefined) throw new Error('This session has an active task. Run cardbush --resume interactively first; no new prompt was submitted.');
    existing.forEach(job => queued.add(job.id));
    while (!lifetime.signal.aborted && !exitRequested) {
      reportDiagnosticError();
      if (prompt === undefined) {
        const jobs = await client.call('chat.jobs', { sessionId: session.sessionId }, lifetime.signal) as AgentJob[];
        const next = jobs.find(job => !observed.has(job.id) && !job.guidance &&
          (queued.has(job.id) || job.status === 'running' || job.status === 'queued'));
        if (next) {
          try { await run(next); }
          catch (error) {
            const latest = (await client.call('chat.jobs', { sessionId: next.sessionId }) as AgentJob[]).find(job => job.id === next.id);
            if (!latest || ['running', 'queued'].includes(latest.status)) throw error;
            io.status(`[Error] ${error instanceof Error ? error.message : 'Task did not complete'}\n`);
          }
          continue;
        }
      }
      const text = prompt ?? await io.ask('❯ ', lifetime.signal, true);
      if (text === null) break;
      if (prompt === undefined && await referenceCommand(text)) continue;
      if (prompt === undefined && isChatExitCommand(text)) { io.commitInput(text); break; }
      const shellCommand = prompt === undefined ? chatShellCommand(text) : undefined;
      if (shellCommand !== undefined) {
        io.commitInput(text);
        const cwd = local ? session.metadata?.runtimeWorkspace?.workspaceDir ?? session.metadata?.projectDir ?? process.cwd() : process.cwd();
        await executeChatShell(io, shellCommand, cwd, lifetime.signal); continue;
      }
      if (prompt === undefined && uncertain.has(text)) { queueRunningInput(text); await inputWork; continue; }
      if (prompt === undefined && text.trim() === '/help') { io.commitInput(text); io.status(help); continue; }
      if (prompt === undefined && /^\/steer(?:\s|$)/.test(text.trim())) {
        io.commitInput(text);
        io.status('No task is running. Send a normal message to start a turn.\n'); continue;
      }
      if (prompt === undefined && /^\/model(?:\s|$)/.test(text.trim())) {
        io.commitInput(text);
        const fresh = await readChatModels(client, io, lifetime.signal);
        if (!fresh) break;
        config = fresh;
        if (!config.models.some(model => model.id === modelId)) modelId = config.defaultModelId;
        modelId = await selectChatModel(config, modelId, text.trim().slice('/model'.length), io, lifetime.signal);
        io.updateModel(config.models.find(model => model.id === modelId)?.modelName ?? modelId, config.models.map(model => model.id));
        completion!.update({ sessionId: session.sessionId, workspace: session.metadata?.runtimeWorkspace?.workspaceDir ?? session.metadata?.projectDir ?? undefined, platform: info.platform, models: config.models });
        selectedModel = true; continue;
      }
      if (prompt === undefined && text.trim() === '/settings') {
        io.commitInput(text);
        if (!client.settingsDirectory) { io.status('Connected to a remote Agent. Change model and plugin settings on that Agent.\n'); continue; }
        io.status(`\nJSON settings shared with CardBush App:\n${[
          ['Models', 'models.json'], ['Plugins', 'apps.json'], ['MCP', 'mcp-servers.json'], ['Network', 'network.json'], ['Sandbox', 'sandbox.json'],
        ].map(([label, name]) => `${label}: ${join(client.settingsDirectory!, name)}`).join('\n')}\nEdit these files directly or use App settings.\n`);
        const answer = await waitForChatConfiguration(io, lifetime.signal, ['/cancel']);
        if (answer === null) break;
        if (answer.trim() === '/cancel') continue;
        const fresh = await readChatModels(client, io, lifetime.signal);
        if (!fresh) break;
        config = fresh;
        if (!selectedModel || !config.models.some(model => model.id === modelId)) modelId = config.defaultModelId;
        try { await client.reloadSettings?.(); io.status('Settings reloaded.\n'); }
        catch { io.status('Model settings loaded, but tool settings could not refresh. Check the JSON configuration or /logs.\n'); }
        identify(); continue;
      }
      if (prompt === undefined && text.trim() === '/logs') {
        io.commitInput(text);
        showLogs();
        continue;
      }
      if (prompt === undefined && text.trim() === '/plan') {
        io.commitInput(text); await readPlan(); continue;
      }
      if (prompt === undefined && text.trim() === '/new') { io.commitInput(text); session = await createSession(); referenceTurn = undefined; identify(); continue; }
      if (!text.trim()) continue;
      validatePrompt(text);
      const job = { id: randomUUID(), sessionId: session.sessionId, turnId: `turn-${randomUUID()}`, text };
      try {
        const prepared = await completion!.prepare(text, lifetime.signal);
        const result = await run(job, { requestId: job.id, sessionId: job.sessionId, turnId: job.turnId, ...prepared, modelId,
          // UI language is only a fallback; the Agent follows the user's language.
          permissionMode: permissionMode as AgentSendInput['permissionMode'], language: 'en' });
        if (prompt !== undefined) return result;
      } catch (error) {
        if (prompt !== undefined || lifetime.signal.aborted) throw error;
        // Only a durably finished task may return to a fresh input prompt.
        // A lost connection can leave work running; preserve resume semantics.
        const jobs = await client.call('chat.jobs', { sessionId: job.sessionId }, lifetime.signal).catch(() => []) as AgentJob[];
        const finished = jobs.find(item => item.id === job.id);
        if (!finished || !['failed', 'completed', 'stopped'].includes(finished.status)) throw error;
        io.status(`[Error] ${error instanceof Error ? error.message : 'Task did not complete'}\n`);
      }
    }
    return lifetime.signal.aborted ? 130 : 0;
  } catch (error) {
    if (lifetime.signal.aborted) return 130;
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    completion?.close();
    io.close();
    try { await client.close(); }
    finally {
      reportDiagnosticError();
      if (session) process.stderr.write(resumeHint(session.sessionId, Boolean(process.stderr.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'), values.local));
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(terminalText(error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = typeof error?.exitCode === 'number' ? error.exitCode : 1;
  });
}
