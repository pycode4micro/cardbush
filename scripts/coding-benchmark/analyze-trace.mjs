import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Diagnostic comparisons only. These transformations must never be used to
// choose a write target: they explain a failed exact match without relaxing it.
export function analyzeTrace(trace) {
  const failedEdits = trace.toolExecutions.filter(record =>
    record.toolCall.name === 'edit_file' && record.outcome === 'failed').map(record => {
    const args = JSON.parse(record.toolCall.argumentsText);
    const request = trace.requests.find(round => round.outputToolCalls.some(call => call?.id === record.toolCall.id));
    const normalizePath = path => path.replaceAll('\\', '/').toLowerCase();
    const path = Object.keys(request?.sourceRevisions ?? {}).find(path =>
      normalizePath(args.path).endsWith(normalizePath(path)));
    const source = trace.sourceSnapshots[request?.sourceRevisions[path]];
    const comparisons = [];
    if (typeof source === 'string' && typeof args.old_text === 'string') {
      const candidates = {
        exact: args.old_text,
        reducedPairedBackslashes: args.old_text.replaceAll('\\\\', '\\'),
        normalizedCRLF: args.old_text.replaceAll('\r\n', '\n'),
      };
      for (const [name, text] of Object.entries(candidates)) {
        if (name !== 'exact' && text === args.old_text) continue;
        const start = source.indexOf(text);
        if (start >= 0) comparisons.push({ name, line: source.slice(0, start).split(/\r\n|\r|\n/).length });
      }
    }
    const read = trace.toolExecutions.findLast(item =>
      item.round <= record.round && item.toolCall.name === 'read_file' && item.result?.sha256 === request?.sourceRevisions[path]);
    const visible = request?.messages.findLast(message => message.role === 'tool' && message.toolCallId === read?.toolCall.id);
    return {
      round: record.round, request: request?.request, path: args.path,
      error: record.error?.code, oldText: args.old_text, newText: args.new_text,
      comparisons, observedRevisionMatchesSnapshot: Boolean(read),
      readVisibleToModel: Boolean(visible),
      readProjectionArchived: visible ? safeJSON(visible.content)?.archived === true : null,
    };
  });
  return {
    taskId: trace.taskId, terminal: trace.terminal, stopReason: trace.stopReason,
    requests: trace.requests.map(({ messages, sourceRevisions, outputToolCalls, ...round }) => ({
      ...round, tools: outputToolCalls.filter(Boolean).map(call => call.name),
    })),
    failedEdits,
    terminals: trace.toolExecutions.filter(record => record.toolCall.name.startsWith('terminal_')).map(record => ({
      round: record.round, name: record.toolCall.name, arguments: JSON.parse(record.toolCall.argumentsText), result: record.result,
    })),
    runtimeEvents: trace.runtimeEvents,
  };
}

function safeJSON(value) {
  try { return JSON.parse(value); }
  catch {
    try { return JSON.parse(value.slice(0, value.indexOf('\n\n'))); }
    catch { return null; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const trace = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
  console.log(JSON.stringify(analyzeTrace(trace), null, 2));
}
