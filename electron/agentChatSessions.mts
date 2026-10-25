import { finalReplySessionSnapshot, normalizeIndividuation, sessionHistoryPageSchema, type CommittedTurn, type SessionHistoryCursor, type SessionSummary } from '@cardbush/bush-protocol';
import type { AgentHttpClient } from './agentHttpClient.mjs';
import type { ChatTerminal } from './agentChatCli.mjs';
import { terminalText } from './agentChatPresentation.mjs';

export type ChatSession = Pick<SessionSummary, 'sessionId'> & Partial<Omit<SessionSummary, 'sessionId'>>;
type Client = Pick<AgentHttpClient, 'call'>;
// Read current server preferences so two windows attached to one session do not
// silently submit stale switches. Each submitted job retains its own snapshot.
export async function readChatIndividuation(client: Client, sessionId: string, signal: AbortSignal) {
  const sessions = await client.call('sessions.list', { projection: 'summary' }, signal) as ChatSession[];
  const session = sessions.find(item => item.sessionId === sessionId);
  if (!session) throw new Error('Session not found.');
  return normalizeIndividuation(session.metadata?.individuation);
}
const clean = (text: string) => terminalText(text).replace(/\s+/g, ' ').trim();
export const chatSessionTitle = (session: ChatSession) => clean(typeof session.metadata?.title === 'string'
  ? session.metadata.title : session.firstUserText || session.sessionId);
export function chatSessionWorkspace(session: ChatSession): string | undefined {
  const workspace = session.metadata?.runtimeWorkspace as { workspaceDir?: unknown } | undefined;
  return typeof workspace?.workspaceDir === 'string' ? workspace.workspaceDir
    : typeof session.metadata?.projectDir === 'string' ? session.metadata.projectDir : undefined;
}

function sessionTime(value?: string): string {
  const date = new Date(value ?? '');
  if (!Number.isFinite(date.getTime())) return 'Unknown time';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** parseArgs has no optional option values. Normalize only actual --resume
 * switches, never prompt text or another string option's value. */
export function optionalResumeArgs(args: string[]) {
  const normalized: string[] = []; let picker = false;
  const strings = new Set(['--url', '--token-file', '--session', '--resume', '--project', '--model', '--prompt', '--permission']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { normalized.push(...args.slice(i)); break; }
    if (arg === '--resume' && (args[i + 1] === undefined || args[i + 1]!.startsWith('-'))) {
      normalized.push('--resume='); picker = true;
    } else {
      normalized.push(arg);
      if (strings.has(arg) && args[i + 1] !== undefined) normalized.push(args[++i]!);
    }
  }
  return { args: normalized, picker };
}

export async function selectChatSession(client: Client, io: ChatTerminal, signal: AbortSignal,
  argument = '', current?: string): Promise<ChatSession | undefined> {
  const sessions = await client.call('sessions.list', { projection: 'summary' }, signal) as ChatSession[];
  const ordered = [...sessions].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.sessionId.localeCompare(b.sessionId));
  if (!ordered.length) { io.status('No saved sessions. Run cardbush to start one.\n'); return; }
  let selection = argument.trim();
  if (!selection) {
    const title = 'Sessions · most recent first · local time';
    const choices = ordered.map((item, index) => ({ value: item.sessionId,
      label: `${index + 1}. ${chatSessionTitle(item)}${item.sessionId === current ? ' · current' : ''}`,
      description: [sessionTime(item.updatedAt), clean(chatSessionWorkspace(item) ?? ''), clean(item.sessionId)].filter(Boolean).join(' · ') }));
    // Terminals without cursor controls still need a readable numbered list.
    if (!io.selectionMenus) io.status(`\n${title}\n${choices.map(item => `  ${item.label}\n     ${item.description}`).join('\n')}\nEnter a number or session ID; /cancel returns.\n`);
    selection = (await io.ask('Select a session: ', signal, { choices: [
      ...choices,
      { value: '/cancel', description: 'Return without switching' },
    ], picker: { title, selected: current ?? ordered[0]!.sessionId,
      cancelValue: '/cancel', cancelLabel: 'cancel' } }))?.trim() ?? '';
  }
  signal.throwIfAborted();
  if (!selection || selection === '/cancel') return;
  const selected = ordered.find(item => item.sessionId === selection)
    ?? (/^[1-9]\d*$/.test(selection) ? ordered[Number(selection) - 1] : undefined);
  if (!selected) io.status('Session not found. Use /session and choose a number or session ID.\n');
  return selected;
}

/** Use the GUI's paginated, revision-checked history read. Only compact replies
 * cross the wire; full execution facts stay behind /tools. */
export async function readChatHistory(client: Client, sessionId: string, signal: AbortSignal): Promise<CommittedTurn[]> {
  const turns = new Map<string, CommittedTurn>();
  let cursor: SessionHistoryCursor | undefined;
  do {
    signal.throwIfAborted();
    const value = await client.call('runtime.command', { kind: 'runtime.get_session_history', payload: {
      sessionId, limit: 100, messageProjection: 'final_replies', ...(cursor ? { cursor } : {}),
    } }, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
    if (!value) throw new Error('Session history no longer exists.');
    const page = sessionHistoryPageSchema.parse(value);
    if (page.snapshot.sessionId !== sessionId) throw new Error('Session history identity mismatch.');
    // Also support an older server that ignores the optional projection field.
    for (const turn of finalReplySessionSnapshot(page.snapshot).turns) turns.set(turn.turnId, turn);
    const next = page.nextCursor;
    if (next && cursor && next.beforeTurnSequence >= cursor.beforeTurnSequence) throw new Error('Session history cursor did not advance.');
    cursor = next ?? undefined;
  } while (cursor);
  return [...turns.values()].sort((a, b) => a.turnSequence - b.turnSequence);
}
