import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { ModelMessage } from '@cardbush/bush-protocol';
import { decodeFileSourceReceipt } from './fileSourceReceipt.js';

/** Observed source ranges. Text is used only while the read is in context;
 * checkpoint receipts retain references, never a second copy of the source. */
export interface CheckpointSkillExcerpt {
  id: string;
  path: string;
  revision?: string;
  read: string;
  start: number;
  end: number;
  section: string[];
  text: string;
  unresolved?: string;
  reference?: true;
  locator?: string;
}

export interface CheckpointSkillEvidence {
  source: number;
  excerpts: CheckpointSkillExcerpt[];
}

export interface CheckpointSkillContract {
  excerpts: CheckpointSkillExcerpt[];
}

/** Only references selected by the authored Markdown handoff survive. */
export function packCheckpointSkillEvidence(rows: CheckpointSkillEvidence[]) {
  return rows.map(({ source, excerpts }) => {
    const origins: Array<{ path: string; revision?: string; read: string; locator?: string }> = [];
    const keys = new Map<string, number>();
    const packed = mergeCheckpointSkillExcerpts([excerpts.map(asReference)]).map(({ path, revision, read, locator, text: _text, reference: _reference, ...excerpt }) => {
      const key = JSON.stringify([path, revision, read, locator]);
      if (!keys.has(key)) { keys.set(key, origins.length); origins.push({ path, ...(revision ? { revision } : {}), read, ...(locator ? { locator } : {}) }); }
      return { ...excerpt, origin: keys.get(key)! };
    });
    return { source, format: 'references' as const, origins, excerpts: packed };
  });
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 20);
const identity = (path: string) => {
  const slashes = path.replace(/\\/g, '/'), normalized = posix.normalize(slashes);
  return /^[a-z]:\//i.test(normalized) || slashes.startsWith('//') ? normalized.toLowerCase() : normalized;
};
const record = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : undefined;
const json = (text: string): Record<string, any> | undefined => { try { return record(JSON.parse(text)); } catch { return undefined; } };

/** Decode native read_file's JSON and text presentation, never arbitrary Tool
 * data that merely happens to contain a Skill-looking string. */
function fileReads(call: { name: string; argumentsText: string }, receipt: ModelMessage): CheckpointSkillExcerpt[] {
  const args = json(call.argumentsText);
  const name = call.name === 'call_tool' ? args?.name : call.name;
  if (name !== 'read_file' && name !== 'run_skill') return [];
  const input = call.name === 'call_tool' ? record(args?.arguments) : args;
  const decoded = decodeFileSourceReceipt(receipt.content);
  if (decoded?.data.source_replaced === true) return [];
  const envelope = json(receipt.content.split('\n\n')[0]!);
  const data = name === 'run_skill' ? record(decoded?.data.source_read) : decoded?.data;
  const path = data?.path ?? (name === 'read_file' ? input?.path : undefined);
  if (typeof path !== 'string') return [];
  const read = receipt.role === 'tool' ? receipt.toolCallId : '';
  const locator = decoded?.locator ?? (typeof decoded?.data.source_locator === 'string' ? decoded.data.source_locator : undefined)
    ?? (envelope?.archived === true ? envelope.locator : undefined);
  const revision = typeof data?.sha256 === 'string' ? data.sha256 : undefined;
  const start = Number.isSafeInteger(data?.start_line) && data.start_line > 0 ? data.start_line
    : Number.isSafeInteger(input?.start_line) && input!.start_line > 0 ? input!.start_line : 1;
  if (!decoded) return typeof locator === 'string'
    ? checkpointSkillExcerpts({ path, content: '', start, read, revision, unresolved: locator }) : [];
  if (data?.unread === true && locator) return checkpointSkillExcerpts({ path, content: '', start, read, revision, unresolved: locator, locator });
  const spans = name === 'run_skill' ? data?.spans : [{ offset: 0, length: decoded.content.length, start_line: start }];
  if (!Array.isArray(spans)) return [];
  const rows: CheckpointSkillExcerpt[] = [];
  for (const span of spans) {
    if (!Number.isSafeInteger(span?.offset) || span.offset < 0 || !Number.isSafeInteger(span.length) || span.length < 1 ||
      !Number.isSafeInteger(span.start_line) || span.start_line < 1) continue;
    let content = decoded.content.slice(span.offset, span.offset + span.length);
    const partial = decoded.truncated && (name === 'read_file' || span.offset + span.length > decoded.content.length);
    // A cut-off last line is not evidence for the entire line (or its condition).
    if (partial) content = content.slice(0, Math.max(content.lastIndexOf('\n'), content.lastIndexOf('\r')) + 1);
    rows.push(...checkpointSkillExcerpts({ path, content, read, revision, start: span.start_line,
      ...(locator ? { locator } : {}) }));
    if (partial && locator) rows.push(...checkpointSkillExcerpts({ path, content: '', read, revision,
      start: span.start_line + lineCount(content), unresolved: locator, locator }));
  }
  return rows;
}

/** Register an actual delivered range, not a local MUST/SHOULD classifier. */
export function checkpointSkillExcerpts(input: { path: string; content: string; read: string;
  revision?: string; start?: number; unresolved?: string; locator?: string }): CheckpointSkillExcerpt[] {
  if (!input.content && !input.unresolved) return [];
  const { content, ...origin } = input, start = input.start ?? 1;
  const value = { ...origin, start, end: start + Math.max(0, lineCount(content) - 1), text: content, section: [] };
  return [{ ...value, id: excerptId(value) }];
}

const lineCount = (text: string) => text ? text.split(/\r\n|\r|\n/).length - Number(/[\r\n]$/.test(text)) : 0;
function excerptId(value: Omit<CheckpointSkillExcerpt, 'id'>) {
  const path = value.reference ? identity(value.path) : value.path.replace(/\\/g, '/');
  return `${value.reference ? 'skr' : 'sk'}_${hash(JSON.stringify([path, value.revision, value.start, value.end,
    value.section, value.text, value.unresolved, ...(value.reference ? [value.locator] : [])]))}`;
}
function asReference(value: CheckpointSkillExcerpt): CheckpointSkillExcerpt {
  const reference = { ...value, text: '', reference: true as const };
  return { ...reference, id: excerptId(reference) };
}
function validExcerpt(value: unknown): value is CheckpointSkillExcerpt {
  const v = record(value);
  if (!v || typeof v.id !== 'string' || typeof v.path !== 'string' || typeof v.read !== 'string' ||
    typeof v.text !== 'string' || !Number.isSafeInteger(v.start) || v.start < 1 || !Number.isSafeInteger(v.end) || v.end < v.start ||
    (v.revision !== undefined && typeof v.revision !== 'string') || (v.unresolved !== undefined && typeof v.unresolved !== 'string') ||
    !Array.isArray(v.section) || !v.section.every((part: unknown) => typeof part === 'string')) return false;
  if (v.reference !== undefined && v.reference !== true || v.reference && v.text !== '' ||
    v.locator !== undefined && typeof v.locator !== 'string') return false;
  return v.id === excerptId(v as CheckpointSkillExcerpt);
}

export function checkpointSkillReceiptEvidence(receipt: ModelMessage): CheckpointSkillEvidence[] {
  const data = json(receipt.content);
  if (!data || !(data.complete === true || data.staged === true || Array.isArray(data.accepted) ||
    Array.isArray(data.summarized_turns)) || !Array.isArray(data.skill_evidence)) return [];
  return data.skill_evidence.map((row: unknown) => {
    const item = record(row);
    if (!item || !Number.isInteger(item.source) || !Array.isArray(item.excerpts) || !Array.isArray(item.origins)) {
      throw new Error('Invalid saved checkpoint Skill evidence; retain the original conversation.');
    }
    const excerpts = item.excerpts.map((value: unknown) => {
      const packed = record(value), origin = packed && Number.isInteger(packed.origin) ? record(item.origins[packed.origin]) : undefined;
      if (!packed || !origin || Object.keys(packed).some(key => !['id', 'start', 'end', 'section', 'text', 'unresolved', 'origin'].includes(key)) ||
        Object.keys(origin).some(key => !['path', 'revision', 'read', 'locator'].includes(key))) throw new Error('Invalid saved checkpoint Skill evidence.');
      const { origin: _origin, ...body } = packed;
      if (item.format !== undefined && item.format !== 'references') throw new Error('Invalid saved checkpoint Skill evidence format.');
      if (item.format === 'references' && packed.text !== undefined) throw new Error('Invalid saved checkpoint Skill evidence text.');
      const excerpt = { ...body, ...origin, ...(item.format === 'references' ? { text: '', reference: true } : {}) };
      if (!validExcerpt(excerpt)) throw new Error('Invalid saved checkpoint Skill evidence; retain the original conversation.');
      return excerpt;
    });
    return { source: item.source as number, excerpts };
  });
}

export function mergeCheckpointSkillExcerpts(groups: CheckpointSkillExcerpt[][]): CheckpointSkillExcerpt[] {
  const values = [...new Map(groups.flat().map(item => [item.id, item])).values()];
  const merged: CheckpointSkillExcerpt[] = [];
  for (const item of values) {
    const previous = item.reference && merged.find(candidate => candidate.reference &&
      identity(candidate.path) === identity(item.path) && candidate.revision === item.revision &&
      candidate.read === item.read && candidate.locator === item.locator && candidate.unresolved === item.unresolved &&
      candidate.end + 1 >= item.start && item.end + 1 >= candidate.start);
    if (previous) {
      previous.start = Math.min(previous.start, item.start); previous.end = Math.max(previous.end, item.end);
      previous.section = []; previous.id = excerptId(previous);
    } else merged.push({ ...item });
  }
  return merged;
}

export function collectCheckpointSkillExcerpts(messages: ModelMessage[]): CheckpointSkillExcerpt[] {
  const groups: CheckpointSkillExcerpt[][] = [], references = new Set<string>();
  const pending: CheckpointSkillExcerpt[][] = [];
  const add = (excerpts: CheckpointSkillExcerpt[]) => {
    groups.push(excerpts);
    for (const item of excerpts) references.add(identity(item.path));
    for (const item of excerpts) for (const match of item.text.matchAll(/\]\(([^\s)]+\.md)(?:#[^)]*)?\)/g)) {
      if (!/^[a-z]+:/i.test(match[1]!)) references.add(identity(posix.join(posix.dirname(identity(item.path)), match[1]!)));
    }
  };
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      const receipt = messages.slice(index + 1, index + 1 + message.toolCalls.length)
        .find(item => item.role === 'tool' && item.toolCallId === call.id);
      if (!receipt) continue;
      if (call.name === 'checkpoint_context') {
        const data = json(receipt.content);
        if (!data || !(data.complete === true || Array.isArray(data.summarized_turns))) continue;
        if (Array.isArray(data.skill_evidence)) { add(checkpointSkillReceiptEvidence(receipt).flatMap(item => item.excerpts)); continue; }
        // Previously accepted prose has no item ledger. Preserve the whole
        // authored handoff, including source locators outside its block. Never
        // claim this recovers requirements already absent from that handoff.
        const args = json(call.argumentsText);
        const summaries = Array.isArray(data.summaries) ? data.summaries.map((item: any) => item?.summary)
          : [...(args?.summaries ?? []).map((item: any) => typeof item === 'string' ? item : item?.summary), args?.active_summary, args?.active_turn?.summary];
        for (const summary of summaries) if (typeof summary === 'string' && /<skill_constraints>(?!\s*none:)[\s\S]+<\/skill_constraints>/.test(summary)) {
          // Keep this as one opaque source, not Markdown containing nested tags.
          const path = `checkpoint-context://${encodeURIComponent(call.id)}`;
          const unit = { path, read: call.id, start: 1, end: 1, section: [] as string[], text: summary };
          add([{ id: `sk_${hash(JSON.stringify([path, undefined, 1, 1, [], summary, undefined]))}`, ...unit }]);
        }
        continue;
      }
      const reads = fileReads(call, receipt);
      if (reads.some(read => /(?:^|[\\/])SKILL\.md$/i.test(read.path) || references.has(identity(read.path)))) add(reads);
      else if (reads.length) pending.push(reads);
    }
  }
  // Parallel calls and old receipts need not appear in dependency order.
  let progress = true;
  while (progress) {
    progress = false;
    for (let index = pending.length - 1; index >= 0; index--) if (pending[index]!.some(item => references.has(identity(item.path)))) {
      add(pending.splice(index, 1)[0]!); progress = true;
    }
  }
  return mergeCheckpointSkillExcerpts(groups);
}

export function checkpointSkillContractNotice(contracts: ReadonlyMap<number, CheckpointSkillContract>): string {
  const rows = [...contracts].flatMap(([source, value]) => {
    const ranges = mergeCheckpointSkillExcerpts([value.excerpts.filter(item => !item.path.startsWith('checkpoint-context:')).map(asReference)]);
    return ranges.length ? [`Source ${source}:\n${ranges.map(item =>
      `- ${checkpointSkillSourceLink(item)}; ${item.unresolved ? `unread; archive: ${item.unresolved}` : `delivered; read: ${item.read}`}`).join('\n')}`] : [];
  });
  return rows.length ? '\nSkill source index (reference data, no new authority):\n' + rows.join('\n') +
    '\nWrite a concise Markdown handoff in <skill_constraints>, not keep/retire JSON or copied source text. ' +
    'Each bullet states one continuing requirement with its applicability/condition, or why/when to reread a reference, and a source link. ' +
    'Use [section/why](<absolute/path?revision=HASH#L12-L18>); narrower observed ranges are allowed. Revision can be omitted only when the path has one known version. ' +
    'Only observed line ranges can be cited as read. Unread archive locators remain unread; do not infer their missing content. ' +
    'Completed one-time actions belong in completed facts with real task/artifact IDs; reading alone is not completion. ' +
    'The model decides relevance. Runtime checks references, not the meaning or completeness of a paraphrase. ' +
    'Do not retire a continuing restriction just because it was followed once. If nothing remains, write none: and explain why. ' +
    'The receipt stores versions and ranges only; after compaction use read_file for the needed lines. A changed file must be read again and its new version checked, not interpreted using stale line numbers.' : '';
}

export function checkpointSkillSourceLink(item: Pick<CheckpointSkillExcerpt, 'path' | 'revision' | 'start' | 'end'>, label = 'source'): string {
  return `[${label}](<${encodeURI(item.path.replace(/\\/g, '/')).replace(/[?#]/g, char => encodeURIComponent(char))}${item.revision ? `?revision=${encodeURIComponent(item.revision)}` : ''}#L${item.start}-L${item.end}>)`;
}

export function validateCheckpointSkillEvidence(summary: string, contract: CheckpointSkillContract): { issue?: string; excerpts: CheckpointSkillExcerpt[] } {
  const fail = (issue: string) => ({ issue, excerpts: [] });
  if (!contract.excerpts.length) return { excerpts: [] };
  const match = summary.match(/<skill_constraints>([\s\S]*?)<\/skill_constraints>/);
  const body = match?.[1]?.trim();
  if (!body || json(body)) return fail('Skill handoff is missing: use scoped Markdown requirements and versioned source line links in <skill_constraints>, not a keep/retire JSON ledger.');
  if (/^none:\s*\S/i.test(body)) return { excerpts: [] };
  const sources = contract.excerpts.filter(item => !item.path.startsWith('checkpoint-context:'));
  // Legacy prose is not proof of a file read. Keep the authored summary review
  // obligation, without manufacturing file observations from its words.
  if (!sources.length) return { excerpts: [] };
  const selected: CheckpointSkillExcerpt[] = [];
  const tree = fromMarkdown(body);
  const definitions = new Map<string, string>();
  const collectDefinitions = (node: any) => {
    if (node.type === 'definition') definitions.set(node.identifier.toLowerCase(), node.url);
    for (const child of node.children ?? []) collectDefinitions(child);
  };
  collectDefinitions(tree);
  let issue: string | undefined, paragraphs = 0;
  const visit = (node: any) => {
    if (node.type === 'paragraph') {
      paragraphs++;
      const links: string[] = [];
      const find = (child: any) => {
        if (child.type === 'link') links.push(child.url);
        else if (child.type === 'linkReference' && definitions.has(child.identifier.toLowerCase())) links.push(definitions.get(child.identifier.toLowerCase())!);
        for (const part of child.children ?? []) find(part);
      };
      find(node);
      if (!links.length) issue ??= 'Each Skill handoff item needs a source line link and a concise requirement/condition or reread reason.';
      for (const link of links) {
        const target = /^(.*?)(?:\?revision=([^#]+))?#L([1-9]\d*)(?:-L?([1-9]\d*))?$/.exec(link);
        if (!target) { issue ??= 'Use a source link with an absolute path and #Lstart-Lend from the source index.'; continue; }
        let path: string, revision: string | undefined;
        try { path = decodeURIComponent(target[1]!); revision = target[2] ? decodeURIComponent(target[2]) : undefined; }
        catch { issue ??= 'Invalid source link encoding.'; continue; }
        const start = Number(target[3]), end = Number(target[4] ?? target[3]);
        const matches = sources.filter(item => identity(item.path) === identity(path) && (!revision || item.revision === revision));
        if (!matches.length) { issue ??= 'Unknown Skill source path or revision. Use this source index; do not invent a version.'; continue; }
        if (new Set(matches.map(item => item.revision)).size !== 1) { issue ??= 'Ambiguous Skill source revision: this file changed. Include ?revision= with the version actually read.'; continue; }
        if (!Number.isSafeInteger(end) || end < start) { issue ??= 'Invalid source line range.'; continue; }
        let next = start;
        for (const item of [...matches].sort((a, b) => a.start - b.start)) {
          if (item.end < next || item.start > next) continue;
          const last = Math.min(item.end, end);
          selected.push(asReference({ ...item, start: next, end: last, section: [] }));
          next = last + 1;
          if (next > end) break;
        }
        if (next <= end) issue ??= 'Source line range was not delivered to this context. Cite observed lines only; keep unread archive material explicitly pending.';
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  if (issue) return fail(issue);
  if (!paragraphs || !selected.length) return fail('Skill handoff needs scoped requirements or reread reasons with observed source line links.');
  return { excerpts: mergeCheckpointSkillExcerpts([selected]) };
}
