// SPDX-License-Identifier: Apache-2.0
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runResourceManagedCommand } from '@cardbush/bush-runtime/processes';
import { formats } from './files.mjs';

const filePath = z.string().min(1).max(4096);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export async function runDocumentJob(kind, action, request, signal) {
  if (!formats[kind]) throw new Error('Unsupported document plugin.');
  const root = await mkdtemp(join(tmpdir(), 'cardbush-document-job-'));
  try {
    const job = join(root, 'request.json'), result = join(root, 'result.json');
    await writeFile(job, JSON.stringify({ kind, action, request }));
    const command = await runResourceManagedCommand({ executable: process.execPath,
      args: ['--max-old-space-size=512', fileURLToPath(new URL('./worker.mjs', import.meta.url)), job, result],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CARDBUSH_DOCUMENT_JOB_ROOT: root }, cwd: root, signal,
      memoryCeilingBytes: 768 * 1024 * 1024, timeoutMs: 120_000, maxOutputBytes: 32_768 });
    const value = await readFile(result, 'utf8').then(JSON.parse).catch(() => null);
    if (!value || !value.ok || command.exitCode !== 0) throw Object.assign(new Error(value?.error ?? `Document worker failed (${command.exitCode}): ${command.stderr.slice(-1000)}`), { code: value?.code ?? 'document_worker_failed' });
    return value.result;
  } finally { await rm(root, { recursive: true, force: true }); }
}

export function createDocumentServer(kind) {
  if (!formats[kind]) throw new Error('Unsupported document plugin.');
  const server = new McpServer({ name: `cardbush-${kind}`, version: '0.1.0' }, {
    instructions: 'Read the matching built-in document skill before authoring. Read progressively, reuse returned SHA-256 revisions, preserve originals, and distinguish structural validation from formula/visual verification. Authoring executes code with normal host tool permissions. Optional LibreOffice capabilities must be checked before promising conversion or recalculation.' });
  function register(name, description, schema, action, readOnly) {
    server.registerTool(name, { description, inputSchema: schema,
      annotations: { readOnlyHint: readOnly, idempotentHint: readOnly, destructiveHint: action === 'author', openWorldHint: action === 'author' },
      _meta: { 'cardbush/plugin_id': kind } }, async (input, context) => {
      try {
        const result = await runDocumentJob(kind, action, input, context.mcpReq.signal);
        const content = [{ type: 'text', text: JSON.stringify(result) }];
        if (action === 'render') {
          const image = await readFile(result.outputs[0].path);
          if (image.length <= 8 * 1024 * 1024) content.push({ type: 'image', data: image.toString('base64'), mimeType: 'image/png' });
        }
        return { content }; // Avoid sending identical data again as structuredContent.
      } catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.message, code: error.code ?? 'document_operation_failed' }) }] }; }
    });
  }
  register('document_environment', 'Check built-in document libraries and optional LibreOffice conversion/recalculation availability.', z.object({}), 'environment', true);
  register('inspect_document', 'Read a bounded page of document content without modifying or recalculating it. offset counts populated XLSX rows, DOCX paragraphs or slides/PDF pages; follow nextOffset. Numbers are returned as serialized text to preserve precision.', z.object({ path: filePath,
    expected_sha256: sha256.optional(), sheet: z.string().max(256).optional(), offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(kind === 'pptx' || kind === 'pdf' ? 1 : 20),
    start_column: z.number().int().min(1).max(16384).default(1) }), 'inspect', true);
  register('author_document', 'Run authoring JavaScript in a separate resource-managed process with preinstalled libraries. Code receives tools, inputs (staged copies), outputs (staged paths). Await all work and write every output. Final paths must be new; publication follows structural checks and original revision checks. This is code execution, not a security sandbox. Read this plugin skill for library usage.', z.object({
    code: z.string().min(1).max(65536), inputs: z.array(z.object({ path: filePath, sha256: sha256.optional() })).max(12).default([]),
    outputs: z.array(filePath).min(1).max(12) }), 'author', false);
  if (kind !== 'pdf') register('convert_document', 'Use installed LibreOffice to convert to PDF, convert DOC to DOCX, or recalculate XLSX into a new file. Reports unavailable engines explicitly. Refuses existing outputs, macros, embedded objects, external data and signatures in OOXML.',
    z.object({ path: filePath, output: filePath, expected_sha256: sha256.optional() }), 'convert', false);
  else register('render_pdf_page', 'Render one PDF page to a new PNG for visual inspection; attaches the image when small enough. Use successive page numbers as needed.',
    z.object({ path: filePath, output: filePath, page: z.number().int().min(1).default(1), scale: z.number().min(0.25).max(3).default(1.5) }), 'render', false);
  return server;
}
export function startDocumentServer(kind) { return serveStdio(() => createDocumentServer(kind)); }
