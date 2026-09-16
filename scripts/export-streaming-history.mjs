import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const values = (args, flag) => args.flatMap((item, index) => item === flag && args[index + 1] ? [args[index + 1]] : []);
const defaultRoot = () => process.platform === 'win32'
  ? join(process.env.APPDATA || join(homedir(), 'AppData/Roaming'), 'cardbush/runtime-state')
  : process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/cardbush/runtime-state')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cardbush/runtime-state');
async function* jsonLines(file) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of lines) if (line.trim()) yield JSON.parse(line); }
  finally { lines.close(); input.destroy(); }
}
const files = async directory => (await readdir(directory)).filter(name => name.endsWith('.jsonl')).map(name => join(directory, name));

export async function exportStreamingHistory(args = process.argv.slice(2), directory = resolve('tmp/streaming-lab')) {
  const root = resolve(values(args, '--runtime-root')[0] || defaultRoot());
  const requested = new Set(values(args, '--turn'));
  const sessions = new Set(values(args, '--session'));
  const committed = new Map();
  for (const file of await files(join(root, 'sessions'))) {
    for await (const row of jsonLines(file)) {
      const event = row.event;
      if (event?.kind === 'turn_committed' && !event.sessionId.startsWith('subagent_session_') &&
          (!sessions.size || sessions.has(event.sessionId))) {
        committed.set(event.payload.turnId, { sessionId: event.sessionId, turn: event.payload });
      }
    }
  }
  const selected = requested.size ? requested : new Set([...committed.values()]
    .sort((a, b) => b.turn.createdAt.localeCompare(a.turn.createdAt)).slice(0, 4).map(value => value.turn.turnId));
  if (!selected.size) throw new Error('No committed history found. Specify --runtime-root and/or --turn.');
  const runtimeTurns = new Map();
  for (const file of await files(join(root, 'events'))) {
    // Each runtime event journal belongs to one turn; inspect its first line
    // before loading any potentially large model/tool diagnostics.
    for await (const row of jsonLines(file)) {
      const first = row.event;
      if (!selected.has(first?.turnId) || (sessions.size && !sessions.has(first.sessionId))) break;
      const events = [];
      for await (const entry of jsonLines(file)) if (entry.event) events.push(entry.event);
      runtimeTurns.set(first.turnId, events);
      break;
    }
  }
  const api = await loadChatTranscript({ source:
    `export {historyReplay} from ${JSON.stringify(resolve('src/features/pre_test/streaming/historyReplay.ts'))};` });
  const cases = [];
  for (const turnId of selected) {
    const events = runtimeTurns.get(turnId);
    if (!events?.length) throw new Error(`No event journal for requested turn: ${turnId}`);
    const sessionId = events[0].sessionId;
    const hash = createHash('sha256').update(sessionId).digest('hex');
    const records = [];
    try {
      const journal = await readFile(join(root, 'tool-executions', hash + '.jsonl'), 'utf8');
      for (const line of journal.split(/\r?\n/).filter(Boolean)) {
        const record = JSON.parse(line).record;
        if (record?.sessionId === sessionId && record.turnId === turnId) records.push(record);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const replay = api.historyReplay(events, records, committed.get(turnId)?.turn);
    cases.push(replay);
    console.log(JSON.stringify({ turnId, ...replay.source, durationMs: replay.duration,
      replayEvents: replay.events.length }));
  }
  const collection = { version: 1, generatedAt: new Date().toISOString(), cases };
  await mkdir(directory, { recursive: true });
  const target = join(directory, 'history.json');
  await writeFile(target, JSON.stringify(collection));
  console.log(`Read-only history export: ${target}`);
  return collection;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await exportStreamingHistory();
