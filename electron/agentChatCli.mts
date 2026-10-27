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
import { chatEffortLabel, readChatModels, selectChatModel, waitForChatConfiguration, type ChatModelSelection } from './agentChatModels.mjs';
import { NativeChatTerminal } from './agentChatTerminal.mjs';
import { terminalText } from './agentChatPresentation.mjs';
import { AgentChatCompletion, isChatExitCommand, type ChatInputOptions } from './agentChatCompletion.mjs';
import { AgentChatReferences, openChatArtifact } from './agentChatReferences.mjs';
import { chatShellCommand, executeChatShell, type runChatShell } from './agentChatShell.mjs';
import { chatBrowserCommand } from './agentChatBrowser.mjs';
import { inspectChatTools, isChatToolEvent } from './agentChatTools.mjs';
import { chatSessionWorkspace, optionalResumeArgs, readChatHistory, readChatIndividuation, selectChatSession, type ChatSession } from './agentChatSessions.mjs';
export { terminalText } from './agentChatPresentation.mjs';

type Client = Pick<AgentHttpClient, 'call' | 'events'> & Pick<ChatClient, 'reconnect'>;
type Job = Pick<AgentJob, 'id' | 'sessionId' | 'turnId'>;
type SavedChatJob = Omit<AgentJob, 'input'> & Pick<AgentSendInput, 'modelId' | 'reasoningEffort'>;
type Interaction = Extract<RuntimeEvent, { kind: 'permission_requested' | 'solution_selection_requested' }>;
const pendingJob = (job: Pick<AgentJob, 'status'>) => job.status === 'running' || job.status === 'queued';
type SettledJobStatus = Exclude<AgentJob['status'], 'running' | 'queued'>;

async function submitAgentMessage(client: Client, input: AgentSendInput, signal: AbortSignal): Promise<AgentJob> {
  try { return await client.call('chat.send', input, signal) as AgentJob; }
  catch (error) {
    // Reconcile a lost acknowledgement by the original idempotency key. Never
    // manufacture a second turn when the first send may already be committed.
    const jobs = await client.call('chat.jobs', { sessionId: input.sessionId }, signal).catch(() => []) as AgentJob[];
    const committed = jobs.find(job => job.id === input.requestId && job.sessionId === input.sessionId);
    if (!committed) throw error;
    return committed;
  }
}
export interface ChatTerminal {
  write(text: string): void;
  status(text: string): void;
  ask(prompt: string, signal: AbortSignal, options?: boolean | ChatInputOptions): Promise<string | null>;
  interactive: boolean;
  readonly selectionMenus?: boolean;
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

async function stopCliJobs(client: Client, sessionId: string, submitted: ReadonlySet<string>, io: Pick<ChatTerminal, 'status'>, observed?: Job) {
  const jobs = await client.call('chat.jobs', { sessionId }, AbortSignal.timeout(15_000)) as AgentJob[];
  const targets = jobs.filter(job => job.sessionId === sessionId && pendingJob(job) && (submitted.has(job.id) || job.id === observed?.id))
    .sort((left, right) => Number(left.status !== 'queued') - Number(right.status !== 'queued'));
  let result = jobs.find(job => job.id === observed?.id);
  // Remove this window's queued work before stopping the active turn; otherwise
  // the service could start a queued successor as the observer closes.
  for (const target of targets) {
    const settled = await stopAgentTurn(client, target, io);
    if (target.id === observed?.id) result = settled;
  }
  return result;
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

async function interactionPending(client: Client, event: Interaction, signal: AbortSignal, cursor: { sequence: number }) {
  if (event.kind === 'permission_requested') {
    const later = await client.call('runtime.command', { kind: 'runtime.list_turn_events', payload: {
      sessionId: event.sessionId, turnId: event.turnId, afterSequence: cursor.sequence,
    } }, signal) as RuntimeEvent[];
    for (const item of later) {
      if (item.sessionId !== event.sessionId || item.turnId !== event.turnId) continue;
      cursor.sequence = Math.max(cursor.sequence, item.sequence);
      if (item.kind === 'turn_terminal' || ['permission_answered', 'permission_rejected', 'permission_expired', 'permission_cancelled'].includes(item.kind)
        && 'permissionId' in item.payload && item.payload.permissionId === event.payload.permissionId) return false;
    }
  } else {
    const pending = await client.call('runtime.command', { kind: 'runtime.list_solution_selections', payload: { sessionId: event.sessionId } }, signal) as Array<{ selectionId: string }>;
    if (!pending.some(item => item.selectionId === event.payload.selectionId)) return false;
  }
  // A service failure/restart can settle a job without a Runtime terminal event.
  const jobs = await client.call('chat.jobs', { sessionId: event.sessionId }, signal) as AgentJob[];
  return jobs.some(item => item.sessionId === event.sessionId && item.turnId === event.turnId && pendingJob(item));
}

async function answerInteraction(client: Client, event: Interaction, io: ChatTerminal, signal: AbortSignal) {
  const cursor = { sequence: event.sequence };
  if (!await interactionPending(client, event, signal, cursor)) return;
  const closed = new AbortController(), stale = new Error('Interaction already settled.');
  const promptSignal = AbortSignal.any([signal, closed.signal]);
  // Keep the event stream closed while reading input, but observe withdrawals
  // and other clients' answers. Cancelling this prompt never stops the task.
  const monitor = (async () => {
    while (!promptSignal.aborted) {
      await delay(1000, undefined, { signal: promptSignal });
      if (!await interactionPending(client, event, promptSignal, cursor)) { closed.abort(stale); return; }
    }
  })().catch(error => { if (!promptSignal.aborted) closed.abort(error); });
  try {
    await submitInteraction(client, event, io, promptSignal, async () => {
      if (!await interactionPending(client, event, promptSignal, cursor)) throw stale;
    });
  } catch (error) {
    signal.throwIfAborted();
    const id = event.kind === 'permission_requested' ? event.payload.permissionId : event.payload.selectionId;
    const code = (error as { code?: string })?.code;
    const settled = error === stale || closed.signal.reason === stale
      || code === (event.kind === 'permission_requested' ? 'permission_not_pending' : 'solution_not_pending')
      // Compatibility with older services which omitted the structured code.
      || error instanceof Error && error.message === (event.kind === 'permission_requested'
        ? `Permission ${id} is not pending.` : 'Solution selection is not pending.');
    if (settled) { io.status('[This request has ended; continuing the existing task]\n'); return; }
    // A lost HTTP acknowledgement is not permission to submit the decision twice.
    if (error instanceof AgentNetworkError && !await interactionPending(client, event, signal, cursor).catch(() => true)) {
      io.status('[Request settled on the Agent; continuing the existing task]\n'); return;
    }
    throw closed.signal.aborted ? closed.signal.reason : error;
  } finally { closed.abort(); await monitor; }
}

async function submitInteraction(client: Client, event: Interaction, io: ChatTerminal, signal: AbortSignal, verifyPending: () => Promise<void>) {
  if (!io.interactive) throw Object.assign(new Error('This task needs interactive confirmation and has been stopped. Run cardbush --resume in a terminal to continue.'), { exitCode: 2 });
  if (event.kind === 'permission_requested') {
    const request = event.payload;
    const details = [`Approval required: ${request.reason}`, request.actions.join(', '), ...request.targets.map(target => `${target.kind}: ${target.value}`)];
    if (!io.selectionMenus) io.status('\n' + details.join('\n') + '\n');
    const answer = await io.ask(io.selectionMenus ? 'Allow once? ' : 'Allow once? [y/N]: ', signal,
      { ...(io.selectionMenus ? { details, transient: true } : {}),
        choices: [{ value: 'n', label: 'Deny' }, { value: 'y', label: 'Allow once' }],
        picker: { title: 'Choose an approval', selected: 'n', cancelValue: 'n', cancelLabel: 'deny' } });
    signal.throwIfAborted();
    if (answer === null) throw Object.assign(new Error('Input closed; task stopped.'), { exitCode: 2 });
    const allow = answer.trim().toLowerCase() === 'y';
    await verifyPending();
    await client.call('runtime.command', { kind: 'runtime.answer_permission', payload: {
      protocol: 'bush.runtime_permission_answer.v1', permissionId: request.permissionId, answerId: randomUUID(),
      decision: allow ? 'allow_once' : 'deny', grantedCapabilityIds: allow ? request.requestedCapabilityIds : [],
    } }, signal);
  } else {
    const request = event.payload;
    const questions = solutionSelectionQuestions(request), answers: SolutionQuestionAnswer[] = [];
    let cancelled = false;
    for (const [position, question] of questions.entries()) {
      const details = [`${questions.length > 1 ? `[${position + 1}/${questions.length}] ` : ''}${question.prompt}`];
      if (!io.selectionMenus) io.status(`\n${details[0]}\n${question.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}\n`);
      let answer: string | null;
      do {
        answer = await io.ask(io.selectionMenus ? 'Answer (or type your own): ' : 'Enter a number or your own answer (/cancel to cancel all): ', signal,
          { ...(io.selectionMenus ? { details, transient: true } : {}),
            choices: [...question.options.map((option, index) => ({ value: String(index + 1), label: `${index + 1}. ${option}` })), { value: '/cancel', description: 'Cancel all' }],
            picker: { title: 'Choose an answer', selected: '1', cancelValue: '/cancel', cancelLabel: 'cancel' } });
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
    await verifyPending();
    await client.call('runtime.command', { kind: 'runtime.answer_solution_selection', payload: {
      selectionId: request.selectionId, sessionId: request.sessionId, turnId: request.turnId,
      ...(cancelled ? { kind: 'cancel' } : request.questions ? { kind: 'answers', answers } : single),
    } }, signal);
  }
}

/** Observe a durable Agent job. Reconnect by event cursor; never resubmit work. */
export interface AgentTurnObservation { cursor?: number; ended?: boolean; segments?: Map<string, string>; interaction?: Interaction }

async function chooseAgentReconnect(client: Client, io: ChatTerminal, signal: AbortSignal, task = true) {
  const answer = await io.ask(task ? 'Reconnect to this task? ' : 'Reconnect to the Agent? ', signal, {
    choices: [{ value: 'reconnect', label: task ? 'Reconnect to the existing task' : 'Reconnect and check existing submissions' },
      { value: '/exit', label: 'Exit CLI; leave tasks on Agent' }],
    picker: { title: 'Task connection', selected: 'reconnect', cancelValue: '/exit', cancelLabel: 'exit' },
  });
  signal.throwIfAborted();
  if (answer === null || answer.trim() === '/exit') return 'exit';
  try { await client.reconnect?.(); }
  catch (error) {
    signal.throwIfAborted();
    io.status(`[Reconnect unavailable] ${error instanceof Error ? error.message : String(error)}\n`);
  }
  signal.throwIfAborted();
  return 'retry';
}

/** An observer error does not establish the task's outcome. Keep the terminal
 * open with the existing job selected; reconnecting never submits new work. */
export async function recoverAgentObservation(client: Client, job: Job, io: ChatTerminal, error: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  const jobs = await client.call('chat.jobs', { sessionId: job.sessionId }, signal).catch(() => []) as AgentJob[];
  signal.throwIfAborted();
  const current = jobs.find(item => item.id === job.id && item.sessionId === job.sessionId);
  if (current && !pendingJob(current)) return current.status;
  io.status(`[Observation paused] ${error instanceof Error ? error.message : String(error)}\n`
    + `Task ${job.id}: ${current ? 'still active on the Agent' : 'current status could not be confirmed'}. Reconnecting observes the same task.\n`);
  return chooseAgentReconnect(client, io, signal);
}

export async function followAgentTurn(client: Client, job: Job, io: ChatTerminal, signal: AbortSignal, observation: AgentTurnObservation = {}): Promise<number> {
  let cursor = observation.cursor, retries = 0, ended = observation.ended ?? false, outputOpen = false;
  const segments = observation.segments ??= new Map<string, string>();
  const lineBreak = () => { if (outputOpen) { io.write('\n'); outputOpen = false; } };
  try {
    while (!ended) {
      signal.throwIfAborted();
      let interaction = observation.interaction;
      try {
        if (!interaction) for await (const frame of client.events({ sessionId: job.sessionId, turnId: job.turnId, afterSequence: cursor }, signal)) {
          if (frame.type === 'end') { ended = observation.ended = true; break; }
          if (frame.type !== 'event') continue;
          const event = decodeRuntimeEvent(frame.event);
          if (event.sessionId !== job.sessionId || event.turnId !== job.turnId) continue;
          if (cursor !== undefined && event.sequence <= cursor) continue;
          cursor = observation.cursor = event.sequence; retries = 0;
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
          } else if (isChatToolEvent(event)) {
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
            interaction = observation.interaction = event; lineBreak(); break;
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
        try { await answerInteraction(client, interaction, io, signal); delete observation.interaction; }
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
       cardbush --resume [session-id] [options]
       cardbush serve --data-dir <directory> [service-options]
       cardbush serve --background | --status | --stop

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
  --resume [ID]     Resume a session; omit ID to choose from saved sessions
  --project ID      Use an existing server project instead of the current directory
  --model ID        Use a configured model; otherwise use the Agent's default
  --full-access     Full access; host restrictions and process protection still apply
  --permission MODE task_free (approval, default), user_free, or all_free
  --prompt TEXT     Run one turn and exit; piped stdin is also accepted as one prompt
  --models          List models
  --projects        List projects
  --sessions        List sessions
  --version         Show the installed Agent/CLI release
  --help            Show help

Service: cardbush serve --help (alias: cardbush-agent). The service and CLI are installed together.

Commands: /model [ID] selects a model and reasoning effort; /settings shows config paths and reloads settings.
          Model selection: Up/Down selects, Tab fills, Enter confirms, Esc goes back; /cancel discards changes.
          Effort: Model setting follows App config; Provider default lets the provider choose.
          Available reasoning levels follow the model's API protocol. App defaults stay unchanged.
          /habit [on|off|status] controls user habit memory; /prediction [on|off|status] controls next-step predictions.
          Omit the argument to show the current setting. Saved per session; new sessions default to off.
          Resume keeps these settings; a fork inherits them and can change them independently.
          /new starts a session; /plan shows the plan; /logs shows the log path;
          /session [ID] switches sessions and restores their last submitted model and effort;
          omit ID to choose from saved sessions;
          /tools [number] [--turn N] inspects tools, arguments and results;
          /artifact [number] opens this turn's files; /source [number] shows evidence;
          /quit (or /exit) exits; /help shows help. Other input is sent to the Agent.
          /browser checks connections. Local Chrome/Edge: approve the first connection in the CardBush extension window;
          no pairing code is needed. The local App and CLI share connections and reconnect automatically after restarts.
          Chrome/Edge work without the desktop App; integrated CardBush tabs require the App.
          /browser pair chrome or /browser pair edge is for manual connection or remote Agent pairing;
          remote Agents keep separate connections. Codes stay in this terminal; keep it open while pairing.
          After repeated failures, automatic recovery pauses. /browser retry retries the host connector;
          click Connect in the extension to retry its saved connection. Temporary disconnects do not require a new pairing code.
          During a task, /exit stops the observed task and this window's queued messages;
          other windows' queued work is preserved. Connection recovery can explicitly leave tasks on the Agent.
          /shell [COMMAND] or !COMMAND runs in this local terminal; exit returns to chat.
Use /artifact, then Tab to choose a file and Enter to open it. Esc clears the selection.
Resuming shows past user messages and final replies. Use /tools --turn N to inspect
an earlier turn. One-shot and piped prompts keep stdout limited to the new reply.
--resume and /session list all sessions on the connected Runtime/Agent, across projects.
The selected session keeps its workspace; the launching shell's directory is unchanged.
Session picker dates show the last update in local time (yyyy-mm-dd HH:mm).
--resume restores the last submitted model and effort; --model ID overrides this at launch.
Sessions without an available saved model use the current default model and its setting.
Web and local file links are clickable in supported terminals. Remote files are
downloaded only when explicitly opened; source details come from the Agent's records.
In Windows Terminal, Ctrl+click an underlined link to open it. /artifact also opens files.
Inline code paths become links when their location is explicit; ordinary code stays text.
After summary_for_user succeeds, the next reply is separated as Final reply.
Approval details stay in the input area while pending; completed choices do not clutter the transcript.
While running, Enter queues the next turn; /steer TEXT guides the current task.
The live input keeps drafts while responses stream. Approval prompts temporarily
take over input and restore the draft afterwards. Esc / Ctrl+C stops the current task.
Type / for command and Skill suggestions. Use @ for workspace files and folders;
quote paths with spaces, e.g. @"folder/file name.txt".
Slash commands prefer exact names and prefixes, then ordered fuzzy matches.
Enter confirms the selected command (e.g. /q selects /quit); Tab only fills it.
Up/Down selects a suggestion, or browses history without suggestions.
Menus use Up/Down to select and Enter to confirm; Esc cancels the current prompt.
Approvals start on Deny; select Allow once and press Enter to allow.
Workspace paths and menu choices support Tab completion without submitting.
Enter on a file suggestion inserts it into the draft before sending.
In /settings or model setup, type vim FILE (or another command) to edit in place.
Shell commands run locally as the CLI user, even when connected to a remote Agent.
Use /shell to enter the native shell for command and path completion; exit returns to chat.
Finish or stop the current task before /model, /settings, /habit, /prediction, /session, /new or shell commands.
Long or multiline pastes are folded; Enter submits the complete text.
Outside menus, Esc stops the running task or clears a draft. Ctrl+C stops the task or exits when idle.
Approvals apply once. Piped mode stops with exit code 2 if confirmation is required.
Responses go to stdout; progress and prompts go to stderr. Native scrollback, selection,
copy and redirection remain available. Model responses follow the user's language.
Local diagnostic logs rotate in logs/runtime.log under the CLI data directory.
Local CLI windows share one background Runtime. Each new window gets its own session;
--resume ID attaches to that session, whose turns remain queued in order.
Closing a window leaves other windows and their tasks running. The host exits when idle.
For remote Agents, use HTTPS or an existing SSH tunnel. Local mode needs no HTTP
service setup and does not copy model credentials.
`;

function validatePrompt(text: string) {
  if (!text.trim() || text.length > 1_000_000) throw new Error('Prompt must not be empty and must contain at most 1,000,000 characters.');
  // Leave room for the request envelope below the existing HTTP 2 MiB limit.
  if (Buffer.byteLength(JSON.stringify(text)) > 2 * 1024 * 1024 - 16 * 1024) throw new Error('Prompt too large. Reference a file on the Agent instead.');
}

export async function main(args = process.argv.slice(2), options: { openArtifact?: typeof openChatArtifact; shell?: typeof runChatShell } = {}): Promise<number> {
  const normalized = optionalResumeArgs(args);
  const { values, positionals, tokens } = parseArgs({ args: normalized.args, allowPositionals: true, tokens: true, options: {
    help: { type: 'boolean' }, url: { type: 'string' }, 'token-file': { type: 'string' }, session: { type: 'string' }, resume: { type: 'string' },
    project: { type: 'string' }, model: { type: 'string' }, prompt: { type: 'string' }, permission: { type: 'string' },
    'full-access': { type: 'boolean' }, local: { type: 'boolean' },
    models: { type: 'boolean' }, projects: { type: 'boolean' }, sessions: { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(help); return 0; }
  if (positionals.length && (positionals.length !== 2 || positionals[0] !== 'resume' || !positionals[1].trim())) {
    throw new Error('Usage: cardbush or cardbush --resume [session-id]');
  }
  // Keep saved scripts compatible, while all documented/generated commands use
  // the normal option spelling. Conflicting forms must never pick a session silently.
  if (tokens.filter(token => token.kind === 'option' && ['session', 'resume'].includes(token.name)).length + Number(Boolean(positionals[1])) > 1) throw new Error('Use only one of --resume, --session, or the legacy resume command.');
  const resumeId = values.resume ?? positionals[1] ?? values.session;
  const pickSession = normalized.picker && resumeId === '';
  if (resumeId !== undefined && !resumeId.trim() && !pickSession) throw new Error('--resume requires a nonempty session ID, or omit the ID to choose a session.');
  if (pickSession && !(process.stdin.isTTY && process.stderr.isTTY)) throw new Error('Choosing a session requires an interactive terminal. Use --sessions to list IDs, then --resume ID.');
  const permissionMode = values['full-access'] ? 'all_free' : values.permission ?? 'task_free';
  if (values['full-access'] && values.permission && values.permission !== 'all_free') throw new Error('--full-access conflicts with --permission.');
  if (!['task_free', 'user_free', 'all_free'].includes(permissionMode)) throw new Error('Invalid --permission. Use task_free, user_free or all_free.');
  if (resumeId !== undefined && values.project) throw new Error('--project applies only to new sessions; resumed sessions keep their workspace.');
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
  const submitted = new Set<string>();
  const uncertain = new Map<string, { input: AgentSendInput; turnId?: string }>();
  const stopCurrent = (job: Job) => stopAgentTurn(client, job, io, submitted);
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
    let reasoningEffort: ChatModelSelection['reasoningEffort'];
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
    session = pickSession ? await selectChatSession(client, io, lifetime.signal)
      : resumeId ? (await client.call('sessions.list', { projection: 'summary' }, lifetime.signal) as ChatSession[]).find(item => item.sessionId === resumeId) : await createSession();
    if (!session && pickSession) return 0;
    if (!session) throw new Error('Session not found.');
    const references = new AgentChatReferences(client, io, options.openArtifact);
    io.setReferenceRenderer(references);
    let referenceTurn: string | undefined;
    const referenceScope = () => references.setScope({ sessionId: session!.sessionId, turnId: referenceTurn,
      workspace: chatSessionWorkspace(session!),
      platform: info.platform, local, hyperlinks: io.hyperlinks });
    const identify = () => {
      const modelName = config.models.find(model => model.id === modelId)?.modelName ?? modelId;
      const workspace = chatSessionWorkspace(session!);
      const context = { sessionId: session!.sessionId, workspace: workspace ?? undefined, platform: info.platform, models: config.models };
      if (completion) completion.update(context);
      else { completion = new AgentChatCompletion(client, context); io.setSuggestionSource(async (line, cursor, signal) => references.suggest(line, cursor) ?? completion!.suggest(line, cursor, signal)); }
      referenceScope();
      io.identify({ name: info.name, model: modelName, effort: chatEffortLabel(config.models.find(model => model.id === modelId), reasoningEffort),
        permission: permissionMode === 'all_free' ? 'Full access' : 'Approval mode', workspace: workspace ?? undefined, sessionId: session!.sessionId, local }, config.models.map(model => model.id));
    };
    let inputWork: Promise<void> = Promise.resolve(), exitRequested = false, waitingSubmissions = 0;
    const observed = new Set<string>();
    const readPlan = async () => {
      const parsed = taskPlanSchema.safeParse(await client.call('runtime.command', { kind: 'runtime.get_plan', payload: { sessionId: session!.sessionId } }, lifetime.signal));
      io.plan(parsed.success ? parsed.data : null, true);
    };
    const showLogs = () => io.status(client.diagnostics ? `Diagnostic log: ${client.diagnostics.path}\n` : 'Connected to a remote Agent; diagnostic logs are on the server.\n');
    const toolCommand = async (text: string) => {
      const match = /^\s*\/tools(?:\s+(.*))?\s*$/s.exec(text);
      if (!match) return false;
      io.commitInput(text);
      try { await inspectChatTools(client, io, { sessionId: session!.sessionId, turnId: referenceTurn }, match[1] ?? '', lifetime.signal); }
      catch (error) { io.status(`[Unavailable] ${error instanceof Error ? error.message : 'Cannot read tool activity'}\n`); }
      return true;
    };
    const referenceCommand = async (text: string) => {
      const match = /^\s*\/(artifact|source)(?:\s+(.*))?\s*$/s.exec(text);
      if (!match) return false;
      io.commitInput(text);
      try { await references.handle(match[1] as 'artifact' | 'source', match[2] ?? '', lifetime.signal); }
      catch (error) { io.status(`[Unavailable] ${error instanceof Error ? error.message : 'Cannot open this reference'}\n`); }
      return true;
    };
    const queueRunningInput = (text: string) => {
      if (exitRequested) return;
      if (isChatExitCommand(text)) {
        io.commitInput(text); exitRequested = true;
        const observed = active;
        // Accepted input may still be waiting for its submission receipt. Drain
        // that work before resolving the exact owned jobs to stop.
        const priorStop = stopping;
        stopping = (async () => {
          await inputWork; await priorStop?.catch(() => undefined);
          return stopCliJobs(client, session!.sessionId, submitted, io, observed);
        })();
        void stopping.catch(() => undefined);
        turn?.abort(); return;
      }
      const retry = uncertain.get(text);
      const target = active ?? (retry ? { id: retry.input.requestId, sessionId: retry.input.sessionId, turnId: retry.turnId ?? retry.input.turnId! } : undefined);
      if (!target || !text.trim()) return;
      if (waitingSubmissions >= 32) { io.status('[Not sent] Submission queue is full. Use input history to retry.\n'); return; }
      waitingSubmissions++;
      inputWork = inputWork.then(async () => {
        const command = text.trim();
        if (await referenceCommand(text)) return;
        if (await toolCommand(text)) return;
        if (command === '/help') { io.commitInput(text); io.status(help); return; }
        if (command === '/logs') { io.commitInput(text); showLogs(); return; }
        if (command === '/plan') { io.commitInput(text); await readPlan(); return; }
        if (await chatBrowserCommand(text, client, io, lifetime.signal)) return;
        if (/^\/(?:model|settings|habit|prediction|new|session)(?:\s|$)/.test(command) || chatShellCommand(text) !== undefined) {
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
            ...prepared, modelId, reasoningEffort, individuation: await readChatIndividuation(client, target.sessionId, lifetime.signal),
            permissionMode: permissionMode as AgentSendInput['permissionMode'], language: 'en',
            ...(steer ? { queueOnly: true } : {}) }, ...(steer ? { turnId: target.turnId } : {}) };
          uncertain.set(text, entry);
        }
        submitted.add(entry.input.requestId);
        const receipt = await submitAgentMessage(client, entry.input, lifetime.signal);
        queued.add(receipt.id);
        if (entry.turnId) {
          io.commitInput(text);
          const messageId = `queued-guidance-${receipt.id}`;
          io.trackGuidance(messageId);
          try { await client.call('chat.queue', { action: 'guide', id: receipt.id, turnId: entry.turnId, mode: 'interrupt_and_continue' }, lifetime.signal); }
          catch (error) {
            const jobs = await client.call('chat.jobs', { sessionId: target.sessionId }, lifetime.signal) as AgentJob[];
            const current = jobs.find(item => item.id === receipt.id);
            // If the old turn ended before delivery, the SAME queued job may
            // already have started. Observe it instead of creating a second one.
            if (!current || current.status === 'queued' && !current.guidance?.applied) throw error;
          }
          const jobs = await client.call('chat.jobs', { sessionId: target.sessionId }, lifetime.signal) as AgentJob[];
          const current = jobs.find(item => item.id === receipt.id);
          if (current?.guidance?.applied) { queued.delete(receipt.id); io.guidanceQueued(messageId); }
          else { io.forgetGuidance(messageId); io.status('[Queued] The previous task ended; this message will run as the next turn.\n'); }
        }
        uncertain.delete(text); io.setQueued(queued.size);
      }).catch(error => {
        io.status(`[Failed] ${error instanceof Error ? error.message : 'Message submission failed'}. Re-enter the same message to retry its original request.\n`);
        io.restoreDraft(text);
      }).finally(() => { waitingSubmissions--; });
    };
    const run = async (job: Job & { text?: string }) => {
      await stopping;
      observed.add(job.id); queued.delete(job.id); io.setQueued(queued.size);
      active = job; turn = new AbortController(); stopping = undefined;
      const signal = AbortSignal.any([turn.signal, lifetime.signal]);
      let outcome: SettledJobStatus | 'detached' = 'detached';
      const observation: AgentTurnObservation = {};
      referenceTurn = job.turnId; referenceScope();
      io.beginTurn(job.text);
      io.flushPendingInput();
      try {
        for (;;) {
          try {
            const result = await followAgentTurn(client, job, io, signal, observation);
            outcome = result === 0 ? 'completed' : 'stopped'; return result;
          } catch (error) {
            if (signal.aborted) throw error;
            if (prompt !== undefined) {
              const current = (await client.call('chat.jobs', { sessionId: job.sessionId }, signal).catch(() => []) as AgentJob[]).find(item => item.id === job.id);
              if (current && !pendingJob(current)) outcome = current.status as SettledJobStatus;
              throw error;
            }
            const recovery = await recoverAgentObservation(client, job, io, error, signal);
            if (recovery === 'retry') continue;
            if (recovery === 'exit') { exitRequested = true; return 1; }
            outcome = recovery as SettledJobStatus;
            throw error;
          }
        }
      } catch (error) {
        if (signal.aborted) {
          const settled = await (stopping ??= stopCurrent(job));
          if (settled?.status === 'completed') { outcome = 'completed'; return 0; }
          if (settled?.status === 'stopped') { outcome = 'stopped'; return 130; }
          if (settled && !pendingJob(settled)) outcome = settled.status as SettledJobStatus;
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
    let liveInputEnabled = false;
    const restoreSession = async (history: boolean, restoreModel: boolean) => {
      const previousJobs = await client.call('chat.jobs', { sessionId: session!.sessionId }, lifetime.signal) as SavedChatJob[];
      const existing = previousJobs.filter(job => pendingJob(job));
      if (existing.length && prompt !== undefined) throw new Error('This session has an active task. Run cardbush --resume interactively first; no new prompt was submitted.');
      if (restoreModel) {
        const previous = previousJobs.at(-1);
        const saved = previous && config.models.some(model => model.id === previous.modelId) ? previous : undefined;
        modelId = saved?.modelId ?? config.defaultModelId;
        reasoningEffort = saved?.reasoningEffort;
        selectedModel = Boolean(saved);
      }
      identify();
      // Render identity before the first prompt; replay needs the live renderer
      // so restored user messages remain visible alongside assistant replies.
      if (prompt === undefined && !liveInputEnabled) {
        io.enableLiveInput(queueRunningInput); liveInputEnabled = true;
      }
      if (history && prompt === undefined) {
        for (const job of previousJobs.filter(job => job.status === 'interrupted').slice(-5)) {
          io.status(`[Interrupted] Task ${job.id}: ${job.error ?? 'Inspect history before resending.'}\n`);
        }
        try {
          const turns = await readChatHistory(client, session!.sessionId, lifetime.signal);
          const running = new Set(existing.map(job => job.turnId));
          for (const saved of turns) {
            if (running.has(saved.turnId)) continue; // The live observer owns this turn.
            referenceTurn = saved.turnId; referenceScope();
            io.historyTurn(saved);
          }
          if (!turns.length) io.status('No completed conversation history yet.\n');
        } catch (error) {
          lifetime.signal.throwIfAborted();
          io.status(`[History unavailable] ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      if (previousJobs.length) referenceTurn = previousJobs.at(-1)!.turnId;
      referenceScope();
      existing.forEach(job => queued.add(job.id)); io.setQueued(queued.size);
    };
    await restoreSession(resumeId !== undefined, resumeId !== undefined && !values.model);
    while (!lifetime.signal.aborted && !exitRequested) {
      reportDiagnosticError();
      if (prompt === undefined) {
        let jobs: AgentJob[];
        try { jobs = await client.call('chat.jobs', { sessionId: session.sessionId }, lifetime.signal) as AgentJob[]; }
        catch (error) {
          lifetime.signal.throwIfAborted();
          io.status(`[Connection paused] ${error instanceof Error ? error.message : String(error)}. Submitted requests retain their original IDs.\n`);
          if (await chooseAgentReconnect(client, io, lifetime.signal, false) === 'exit') break;
          continue;
        }
        for (const [text, entry] of uncertain) {
          const receipt = jobs.find(job => job.id === entry.input.requestId && job.sessionId === entry.input.sessionId);
          if (!receipt || entry.turnId && receipt.status === 'queued' && !receipt.guidance?.applied) continue;
          if (!receipt.guidance && !observed.has(receipt.id)) queued.add(receipt.id);
          uncertain.delete(text); io.clearDraftIf(text);
        }
        io.setQueued(queued.size);
        const next = jobs.find(job => !observed.has(job.id) && !job.guidance &&
          (queued.has(job.id) || job.status === 'running' || job.status === 'queued'));
        if (next) {
          try { await run(next); }
          catch (error) {
            lifetime.signal.throwIfAborted();
            exitRequested = false;
            const latest = (await client.call('chat.jobs', { sessionId: next.sessionId }, lifetime.signal).catch(() => []) as AgentJob[]).find(job => job.id === next.id);
            if (!latest || pendingJob(latest)) {
              observed.delete(next.id);
              if (await recoverAgentObservation(client, next, io, error, lifetime.signal) === 'exit') exitRequested = true;
            }
            // A rejected stop receipt has already been reported. Reconnecting
            // observes the job; it must not inherit the rejected stop promise.
            stopping = undefined;
            io.status(`[Error] ${error instanceof Error ? error.message : 'Task did not complete'}\n`);
          }
          continue;
        }
      }
      const text = prompt ?? await io.ask('❯ ', lifetime.signal, true);
      if (text === null) break;
      if (prompt === undefined && await referenceCommand(text)) continue;
      if (prompt === undefined && await toolCommand(text)) continue;
      if (prompt === undefined && isChatExitCommand(text)) {
        io.commitInput(text);
        try { if (submitted.size) await stopCliJobs(client, session.sessionId, submitted, io); }
        catch (error) { io.status(`[Exit paused] ${error instanceof Error ? error.message : String(error)}\n`); continue; }
        break;
      }
      if (prompt === undefined && /^\s*\/session(?:\s|$)/.test(text)) {
        io.commitInput(text);
        try {
          const selected = await selectChatSession(client, io, lifetime.signal, text.trim().slice('/session'.length), session.sessionId);
          if (!selected || selected.sessionId === session.sessionId) continue;
          session = selected; active = undefined; stopping = undefined;
          queued.clear(); submitted.clear(); observed.clear(); uncertain.clear(); referenceTurn = undefined;
          io.resetSession(); await restoreSession(true, true);
        } catch (error) { lifetime.signal.throwIfAborted(); io.status(`[Session unavailable] ${error instanceof Error ? error.message : String(error)}\n`); }
        continue;
      }
      const shellCommand = prompt === undefined ? chatShellCommand(text) : undefined;
      if (shellCommand !== undefined) {
        io.commitInput(text);
        const cwd = local ? chatSessionWorkspace(session) ?? process.cwd() : process.cwd();
        await executeChatShell(io, shellCommand, cwd, lifetime.signal); continue;
      }
      if (prompt === undefined && uncertain.has(text)) { queueRunningInput(text); await inputWork; continue; }
      if (prompt === undefined && text.trim() === '/help') { io.commitInput(text); io.status(help); continue; }
      if (prompt === undefined && await chatBrowserCommand(text, client, io, lifetime.signal)) continue;
      const memoryCommand = prompt === undefined ? /^\s*\/(habit|prediction)(?:\s+(.*))?\s*$/s.exec(text) : null;
      if (memoryCommand) {
        io.commitInput(text);
        const name = memoryCommand[1], action = memoryCommand[2]?.trim() || 'status';
        if (!['on', 'off', 'status'].includes(action)) { io.status(`Usage: /${name} [on|off|status]\n`); continue; }
        try {
          if (action !== 'status') await client.call('sessions.update', { sessionId: session.sessionId,
            individuation: { [name === 'habit' ? 'habits' : 'predictions']: action === 'on' } }, lifetime.signal);
          const current = await readChatIndividuation(client, session.sessionId, lifetime.signal);
          const enabled = name === 'habit' ? current.habits : current.predictions;
          io.status(`/${name}: ${enabled ? 'on' : 'off'} (this session; applies to future submissions).\n`);
        } catch (error) {
          lifetime.signal.throwIfAborted();
          io.status(`[Memory setting unavailable] ${error instanceof Error ? error.message : String(error)}\n`);
        }
        continue;
      }
      if (prompt === undefined && /^\/steer(?:\s|$)/.test(text.trim())) {
        io.commitInput(text);
        io.status('No task is running. Send a normal message to start a turn.\n'); continue;
      }
      if (prompt === undefined && /^\/model(?:\s|$)/.test(text.trim())) {
        io.commitInput(text);
        const fresh = await readChatModels(client, io, lifetime.signal);
        if (!fresh) break;
        config = fresh;
        if (!config.models.some(model => model.id === modelId)) { modelId = config.defaultModelId; reasoningEffort = undefined; }
        const current = { modelId, reasoningEffort };
        const selection = await selectChatModel(config, current, text.trim().slice('/model'.length), io, lifetime.signal);
        ({ modelId, reasoningEffort } = selection);
        io.updateModel(config.models.find(model => model.id === modelId)?.modelName ?? modelId, config.models.map(model => model.id),
          chatEffortLabel(config.models.find(model => model.id === modelId), reasoningEffort));
        completion!.update({ sessionId: session.sessionId, workspace: chatSessionWorkspace(session), platform: info.platform, models: config.models });
        if (selection !== current) selectedModel = true;
        continue;
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
        if (!selectedModel || !config.models.some(model => model.id === modelId)) { modelId = config.defaultModelId; reasoningEffort = undefined; }
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
      if (prompt === undefined && text.trim() === '/new') {
        io.commitInput(text); session = await createSession(); referenceTurn = undefined;
        active = undefined; stopping = undefined; queued.clear(); submitted.clear(); observed.clear(); uncertain.clear();
        io.resetSession(); identify(); continue;
      }
      if (!text.trim()) continue;
      validatePrompt(text);
      const job = { id: randomUUID(), sessionId: session.sessionId, turnId: `turn-${randomUUID()}`, text };
      try {
        const prepared = await completion!.prepare(text, lifetime.signal);
        const input: AgentSendInput = { requestId: job.id, sessionId: job.sessionId, turnId: job.turnId, ...prepared, modelId, reasoningEffort,
          individuation: await readChatIndividuation(client, job.sessionId, lifetime.signal),
          // UI language is only a fallback; the Agent follows the user's language.
          permissionMode: permissionMode as AgentSendInput['permissionMode'], language: 'en' };
        uncertain.set(text, { input }); submitted.add(job.id);
        const receipt = await submitAgentMessage(client, input, lifetime.signal);
        uncertain.delete(text); queued.add(receipt.id); io.setQueued(queued.size);
        if (prompt !== undefined) return await run(receipt);
        // Another CLI may have started a turn while this window was at its
        // prompt. Observe the session's active turn (including its approvals)
        // before following our queued submission.
      } catch (error) {
        if (prompt !== undefined || lifetime.signal.aborted) throw error;
        io.status(`[Submission not confirmed] ${error instanceof Error ? error.message : 'Message submission failed'}. ${uncertain.has(text) ? 'Re-enter the same message to retry its original request.' : 'The message was not submitted.'}\n`);
        io.restoreDraft(text);
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
