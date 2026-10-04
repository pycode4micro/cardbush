import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ChromeConnectorError } from './bridgeClient.js';
import type { PageCommand } from './pageCapture.js';

export const snapshotSchema = z.object({
  rootUid: z.string().regex(/^cb_\d+$/).optional(),
  query: z.string().trim().min(1).max(200).optional(),
  roles: z.array(z.string().trim().min(1).max(60)).min(1).max(10).optional(),
  fullText: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(200).optional(),
}).superRefine((input, ctx) => {
  if (input.cursor && (input.rootUid || input.query || input.roles || input.fullText !== undefined)) ctx.addIssue({ code: 'custom', message: 'A cursor continues its original query. Pass only cursor and optional limit.' });
  if (input.fullText && !input.rootUid) ctx.addIssue({ code: 'custom', message: 'fullText requires rootUid to read long fields in a focused subtree.' });
});

type SnapshotInput = z.infer<typeof snapshotSchema>;
type Row = { text: string; preview: boolean };
type Capture = {
  id: string; scope: string; pageId: number; document: string; capturedAt: string; expiresAt: number;
  rows: Row[]; bytes: number; nodeCount: number; matchedNodes: number; omittedNodes: number; previewNodes: number;
  filter: { rootUid?: string; query?: string; roles?: string[]; fullText?: boolean };
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === 'string' ? value : '';
const field = (value: unknown) => String(object(value).value ?? '');
const PAGE_CHARACTERS = 7_000;
const CAPTURE_BYTES = 512 * 1024;
const CACHE_BYTES = 2 * 1024 * 1024;
const TTL = 3 * 60_000;

/** Compact AX records live for three minutes, bounded across all sessions. No daemon or full-tree history. */
export class PageSnapshots {
  private captures = new Map<string, Capture>();
  private secret = randomBytes(32);
  private expiry?: NodeJS.Timeout;

  clear(scope: string, pageId?: unknown) {
    for (const [id, capture] of this.captures) if (capture.scope === scope && (pageId === undefined || capture.pageId === pageId)) this.captures.delete(id);
    this.scheduleExpiry();
  }

  async read(command: PageCommand, scope: string, pageId: number, input: SnapshotInput) {
    this.prune();
    let capture: Capture, offset = 0;
    if (input.cursor) {
      const [id, position, signature, ...extra] = input.cursor.split('.');
      const cached = this.captures.get(id);
      offset = Number(position);
      if (extra.length || !cached || !Number.isSafeInteger(offset) || offset < 0 || offset >= cached.rows.length
        || signature !== this.sign(id, position) || cached.scope !== scope || cached.pageId !== pageId) {
        throw new ChromeConnectorError('snapshot_cursor_expired', 'This snapshot cursor is invalid, expired, or belongs to another session/page. Take a fresh snapshot.');
      }
      if (cached.document !== await documentIdentity(command)) {
        this.clear(scope, pageId);
        throw new ChromeConnectorError('snapshot_document_changed', 'The page navigated since this snapshot. Take a fresh snapshot; old cursor and uids must not be reused.');
      }
      capture = cached;
    } else {
      const document = await documentIdentity(command);
      await command('Accessibility.enable');
      const result = object(await command('Accessibility.getFullAXTree'));
      const nodes = (Array.isArray(result.nodes) ? result.nodes : []).map(object);
      if (document !== await documentIdentity(command)) throw new ChromeConnectorError('snapshot_document_changed', 'The page navigated while reading its accessibility tree. Take a fresh snapshot.');
      const selected = subtree(nodes, input.rootUid);
      const query = input.query?.toLocaleLowerCase(), roles = input.roles?.map(role => role.toLowerCase());
      const rows: Row[] = [];
      let bytes = 0, matchedNodes = 0, omittedNodes = 0, previewNodes = 0;
      for (const node of nodes) {
        if (selected && !selected.has(string(node.nodeId))) continue;
        const preview = snapshotRows(node);
        if (!preview.length || roles && !roles.includes(field(node.role).toLowerCase())
          || query && ![field(node.name), field(node.value), field(node.description), field(node.role)].some(text => text.toLocaleLowerCase().includes(query))) continue;
        matchedNodes++;
        const nodeRows = input.fullText ? fullTextRows(node) : preview;
        let omitted = false;
        for (const row of nodeRows) {
          const size = Buffer.byteLength(row.text, 'utf8');
          if (bytes + size > CAPTURE_BYTES || rows.length >= 4000) { omitted = true; break; }
          rows.push(row); bytes += size;
        }
        if (omitted) omittedNodes++;
        if (!input.fullText && preview.some(row => row.preview)) previewNodes++;
      }
      capture = { id: randomBytes(12).toString('hex'), scope, pageId, document, capturedAt: new Date().toISOString(), expiresAt: Date.now() + TTL,
        rows, bytes, nodeCount: nodes.length, matchedNodes, omittedNodes, previewNodes,
        filter: { ...(input.rootUid ? { rootUid: input.rootUid } : {}), ...(input.query ? { query: input.query } : {}), ...(input.roles ? { roles: input.roles } : {}), ...(input.fullText ? { fullText: true } : {}) } };
      this.clear(scope, pageId);
      this.captures.set(capture.id, capture);
      this.prune();
    }
    const limit = input.limit ?? 60;
    const lines: string[] = [];
    let characters = 0;
    while (offset < capture.rows.length && lines.length < limit) {
      const row = capture.rows[offset];
      const cost = JSON.stringify(row.text).length + 2;
      if (characters + cost > PAGE_CHARACTERS) break;
      lines.push(row.text); characters += cost; offset++;
    }
    const hasMore = offset < capture.rows.length;
    const nextCursor = hasMore ? `${capture.id}.${offset}.${this.sign(capture.id, String(offset))}` : undefined;
    const emptyReason = lines.length ? undefined : (capture.matchedNodes ? 'capture_budget_exceeded' : Object.keys(capture.filter).length ? 'no_matches' : 'empty_accessibility_tree');
    const metadata = { pageId, capturedAt: capture.capturedAt, nodeCount: capture.nodeCount, matchedNodes: capture.matchedNodes,
      returned: lines.length, hasMore, ...(nextCursor ? { nextCursor } : {}), ...(emptyReason ? { emptyReason } : {}),
      ...(capture.previewNodes ? { previewNodes: capture.previewNodes } : {}),
      ...(capture.omittedNodes ? { omittedNodes: capture.omittedNodes, captureTruncated: true } : {}), filter: capture.filter };
    const footer = [hasMore ? `More: take_snapshot({"cursor":"${nextCursor}"}).` : 'End of this snapshot.',
      capture.previewNodes ? 'Long fields are previews. Read a focused subtree with rootUid and fullText:true, then continue its cursor.' : '',
      capture.omittedNodes ? `${capture.omittedNodes} nodes were omitted or incomplete at the capture budget. Narrow with rootUid/query/roles; for very long text use a targeted evaluate_script read with explicit offsets.` : '',
    ].filter(Boolean).join(' ');
    // Keep page text in exactly one MCP field. structuredContent carries only pagination metadata.
    return { text: [lines.join('\n') || `No snapshot rows (${emptyReason}).`, footer].join('\n'), structured: metadata };
  }

  private sign(id: string, offset: string) { return createHmac('sha256', this.secret).update(`${id}.${offset}`).digest('hex').slice(0, 24); }
  private prune() {
    for (const [id, capture] of this.captures) if (capture.expiresAt <= Date.now()) this.captures.delete(id);
    let bytes = [...this.captures.values()].reduce((sum, capture) => sum + capture.bytes, 0);
    for (const [id, capture] of this.captures) {
      if (bytes <= CACHE_BYTES && this.captures.size <= 8) break;
      this.captures.delete(id); bytes -= capture.bytes;
    }
    this.scheduleExpiry();
  }
  private scheduleExpiry() {
    clearTimeout(this.expiry);
    if (!this.captures.size) { this.expiry = undefined; return; }
    const next = Math.min(...[...this.captures.values()].map(capture => capture.expiresAt));
    this.expiry = setTimeout(() => this.prune(), Math.max(1, next - Date.now()));
    this.expiry.unref();
  }
}

async function documentIdentity(command: PageCommand) {
  const result = object(await command('Page.getFrameTree'));
  const frame = object(object(result.frameTree).frame);
  if (!frame.id || !frame.loaderId) throw new ChromeConnectorError('snapshot_document_unavailable', 'The page document is not ready. Wait for it to load before taking a snapshot.');
  return JSON.stringify([frame.id, frame.loaderId, frame.url]);
}

function subtree(nodes: Record<string, unknown>[], uid?: string) {
  if (!uid) return undefined;
  const root = nodes.find(node => Number(node.backendDOMNodeId) === Number(uid.slice(3)));
  if (!root) throw new ChromeConnectorError('snapshot_root_missing', `${uid} is not present in the accessibility tree. Take a fresh snapshot.`);
  const byId = new Map(nodes.map(node => [string(node.nodeId), node]));
  const selected = new Set<string>();
  const queue = [string(root.nodeId)];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (selected.has(id)) continue;
    selected.add(id);
    const childIds = byId.get(id)?.childIds;
    if (Array.isArray(childIds)) queue.push(...childIds.map(string));
  }
  return selected;
}

function snapshotRows(node: Record<string, unknown>): Row[] {
  if (node.ignored === true) return [];
  const role = field(node.role) || 'generic';
  if (role === 'InlineTextBox') return []; // Duplicates its StaticText parent.
  const name = field(node.name), description = field(node.description), value = field(node.value);
  const states = (Array.isArray(node.properties) ? node.properties : []).flatMap(value => {
    const property = object(value); return object(property.value).value === true ? [string(property.name)] : [];
  }).filter(Boolean);
  if ((role === 'generic' || role === 'none') && !name && !value && !description && !states.length) return [];
  const backendId = Number(node.backendDOMNodeId), uid = Number.isSafeInteger(backendId) && backendId > 0 ? `cb_${backendId}` : undefined;
  const header = [uid ? `uid=${uid}` : '', `role=${role.slice(0, 80)}`, states.length ? `state=${states.join(',').slice(0, 160)}` : ''].filter(Boolean).join(' ');
  const fields = Object.entries({ name, value, description: description === name ? '' : description }).filter(([, text]) => text);
  let preview = false;
  const parts = fields.map(([key, text]) => {
    const chunk = boundedChunk(text, 0, 500);
    if (chunk.length < text.length) preview = true;
    return `${key}=${JSON.stringify(chunk)}${chunk.length < text.length ? ` [preview; ${text.length} chars]` : ''}`;
  });
  return [{ text: [header, ...parts].join(' '), preview }];
}

function* fullTextRows(node: Record<string, unknown>): Generator<Row> {
  const uid = Number(node.backendDOMNodeId), role = field(node.role).slice(0, 80);
  const header = `${Number.isSafeInteger(uid) && uid > 0 ? `uid=cb_${uid} ` : ''}role=${role}`;
  let emitted = false;
  // Generate lazily so a giant field does not allocate all chunks before the
  // capture budget can stop it. Offsets preserve the original AX field exactly.
  for (const key of ['name', 'value', 'description']) {
    const text = field(node[key]);
    if (key === 'description' && text === field(node.name)) continue;
    for (let offset = 0; offset < text.length;) {
      const chunk = boundedChunk(text, offset, 1000);
      yield { text: `${header} field=${key} offset=${offset} totalChars=${text.length} text=${JSON.stringify(chunk)}`, preview: false };
      emitted = true;
      offset += chunk.length;
    }
  }
  if (!emitted) yield { text: header, preview: false };
}

function boundedChunk(text: string, offset: number, size: number) {
  // Count escaped text too: control characters must not create an oversized row
  // that can neither fit in a page nor advance its cursor.
  let chunk = text.slice(offset, offset + size);
  while (JSON.stringify(chunk).length > 1400) chunk = chunk.slice(0, Math.floor(chunk.length * 0.8));
  if (/[\uD800-\uDBFF]$/.test(chunk) && offset + chunk.length < text.length) chunk = chunk.slice(0, -1);
  return chunk;
}
