import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { collectTurnAttachments, formatTurnAttachmentContext, turnAttachmentContextSchema,
  type ConversationEntry, type RuntimeAttachment, type RuntimeSessionTurnRequest } from '@cardbush/bush-protocol';
import { MAX_MODEL_IMAGE_SOURCE_BYTES, ModelImageStore, readDataImage, readLocalModelImage } from './modelImageStore.js';

// A retained original has one publisher across store instances in this Runtime.
// In particular, a sibling validation must not pin its directory during publish.
const publications = new Map<string, Promise<void>>();
async function publishOriginal<T>(target: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? target.toLowerCase() : target;
  const result = (publications.get(key) ?? Promise.resolve()).then(() => { signal?.throwIfAborted(); return operation(); });
  const settled = result.then(() => {}, () => {});
  publications.set(key, settled);
  try { return await result; }
  finally { if (publications.get(key) === settled) publications.delete(key); }
}

/** Originals belong to the workspace, not to the disposable model-image cache. */
export class AttachmentStore {
  constructor(private readonly dataRoot: string) {}

  async retainConversationEntry(sessionId: string, entry: ConversationEntry, signal?: AbortSignal): Promise<ConversationEntry> {
    if (entry.role !== 'user' || !entry.attachments?.length) return entry;
    const root = join(this.dataRoot, 'attachments', digest(sessionId));
    const attachments = [];
    for (const attachment of entry.attachments) {
      const saved = attachment.path ? await this.retain(root, sessionId, attachment, attachment.path, signal) : {};
      attachments.push({ ...attachment, ...saved });
    }
    return { ...entry, attachments };
  }

  async prepare(request: RuntimeSessionTurnRequest, images: ModelImageStore, signal?: AbortSignal): Promise<void> {
    const configuredRoot = [request.metadata.workspaceDir, request.metadata.projectDir, request.metadata.sessionWorkspaceDir]
      .find((value): value is string => typeof value === 'string' && !!value.trim());
    const localRoot = configuredRoot && !isRemote(configuredRoot) ? resolve(configuredRoot) : undefined;
    const root = localRoot ?? join(this.dataRoot, 'attachments', digest(request.sessionId));
    let hasLocalAttachments = false;
    // Only new inputs are prepared. Persisted history and forked prefixes are immutable.
    for (const entry of [...request.inputMessages]) {
      if (entry.message.role !== 'user') continue;
      const attachments = collectTurnAttachments({ messageId: entry.messageId,
        attachments: entry.metadata?.attachments, images: entry.message.images?.map(image => image.url), preserveImageIndexes: true });
      if (!attachments.length) continue;
      for (const attachment of attachments) {
        const source = attachment.path ?? (attachment.imageIndex === undefined ? undefined : entry.message.images?.[attachment.imageIndex]?.url);
        if (!source) continue;
        const saved = await this.retain(root, request.sessionId, attachment, source, signal);
        Object.assign(attachment, saved);
        if (saved.path && !isRemote(saved.path)) hasLocalAttachments = true;
        if (attachment.imageIndex !== undefined && entry.message.images?.[attachment.imageIndex]) {
          entry.message.images[attachment.imageIndex].url = await images.snapshot(saved.path!, signal);
        }
      }
      entry.metadata = { ...entry.metadata, attachments };
      const context = request.inputMessages.find(item => item.message.role === 'user' && item.message.visibility === 'internal' &&
        item.message.name === 'turn_runtime_context' &&
        turnAttachmentContextSchema.safeParse(item.metadata?.attachmentContext).data?.messageId === entry.messageId);
      if (context) {
        const facts = turnAttachmentContextSchema.parse(context.metadata!.attachmentContext);
        context.message.content = formatTurnAttachmentContext(facts.timeContext, attachments, !!configuredRoot && isRemote(configuredRoot));
      } else {
        // Direct Runtime callers get the same tool paths without having to use the product adapter.
        request.inputMessages.splice(request.inputMessages.indexOf(entry), 0, {
          messageId: `${entry.messageId}:attachments`, createdAt: entry.createdAt,
          metadata: { attachmentContext: { messageId: entry.messageId, timeContext: '' } },
          message: { role: 'user', visibility: 'internal', name: 'turn_runtime_context',
            content: formatTurnAttachmentContext('', attachments, !!configuredRoot && isRemote(configuredRoot)) },
        });
      }
    }
    if (hasLocalAttachments && !localRoot) {
      const taskRoots = Array.isArray(request.metadata.taskRoots) ? request.metadata.taskRoots : [];
      const mcp = request.metadata.mcpContext as Record<string, unknown> | undefined;
      const filesystemRoots = Array.isArray(mcp?.filesystemRoots) ? mcp.filesystemRoots : [];
      request.metadata = { ...request.metadata, taskRoots: [...new Set([...taskRoots, root])],
        mcpContext: { ...mcp, filesystemRoots: [...new Set([...filesystemRoots, root])] } };
    }
  }

  private async retain(root: string, sessionId: string, attachment: RuntimeAttachment, source: string, signal?: AbortSignal): Promise<{ path: string; size?: number; type?: RuntimeAttachment['type'] }> {
    signal?.throwIfAborted();
    if (isRemote(source)) return { path: source };
    const inline = /^data:image\//i.test(source);
    if (!inline && !isAbsolute(source)) throw new Error(`Attachment path must be absolute: ${source}`);
    await mkdir(root, { recursive: true });
    const canonicalRoot = await realpath(root);
    if (!inline) {
      const info = await stat(source).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (info) {
        const canonicalSource = await realpath(source);
        // Reuse workspace-owned uploads and retained originals. Directories remain
        // references; never import an arbitrary directory tree.
        if (info.isDirectory()) return { path: canonicalSource, type: 'folder' };
        if (!info.isFile()) throw new Error(`Attachment is not a regular file: ${source}`);
        if (inside(join(canonicalRoot, '.cardbush-attachments'), canonicalSource)) return { path: canonicalSource, size: info.size };
      }
    }
    const directory = join(canonicalRoot, '.cardbush-attachments', 'originals', digest(JSON.stringify([sessionId, attachment.id, source])));
    // Validate every newly used directory so an existing junction cannot redirect imports.
    let parent = canonicalRoot;
    for (const part of ['.cardbush-attachments', 'originals', basename(directory)]) {
      parent = join(parent, part);
      await mkdir(parent, { recursive: true });
      if (!inside(canonicalRoot, await realpath(parent))) throw new Error('Attachment storage resolves outside the workspace.');
    }
    const decoded = inline ? await readDataImage(source, MAX_MODEL_IMAGE_SOURCE_BYTES, signal) : undefined;
    const fileName = safeName(inline ? `${attachment.name.replace(/\.[^.]+$/, '')}.${decoded!.mime.slice(6)}` : basename(source));
    const target = join(directory, fileName);
    return publishOriginal(target, signal, async () => {
      if (!inside(canonicalRoot, await realpath(directory))) throw new Error('Attachment storage resolves outside the workspace.');
      const existing = await existingFile(target);
      if (existing) return { path: target, size: existing.size };
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        if (decoded) {
          await writeFile(temporary, decoded.content, { flag: 'wx', mode: 0o600, flush: true, signal });
        } else {
          const before = await stat(source);
          if (!before.isFile()) throw new Error(`Attachment is not a regular file: ${source}`);
          await copyFile(source, temporary, constants.COPYFILE_EXCL);
          const after = await stat(source);
          const copied = await stat(temporary);
          if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || copied.size !== before.size) {
            throw new Error(`Attachment changed while being saved: ${source}. Wait for its writer to finish and resend.`);
          }
          // copyFile carries the source mode, including read-only flags. This owned
          // copy must be flushable without changing permissions on the user's file.
          await chmod(temporary, 0o600);
          const file = await open(temporary, 'r+');
          try { await file.sync(); } finally { await file.close(); }
          if (attachment.imageIndex !== undefined) await readLocalModelImage(temporary, signal, MAX_MODEL_IMAGE_SOURCE_BYTES);
        }
        signal?.throwIfAborted();
        try { await link(temporary, target); }
        catch (error) {
          // Windows may report a sharing violation instead of EEXIST when another
          // reader pins the already-published original. Never replace that file.
          if (!['EEXIST', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || !await existingFile(target)) throw error;
        }
        const saved = await existingFile(target);
        if (!saved) throw new Error('Attachment original was not saved.');
        return { path: target, size: saved.size };
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`Cannot retain attachment ${JSON.stringify(attachment.name)} from ${inline ? 'inline image' : source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      } finally { await rm(temporary, { force: true }); }
    });
  }
}

function digest(value: string) { return createHash('sha256').update(value).digest('hex').slice(0, 32); }
function isRemote(value: string) { return /^(?:https?|ssh):\/\//i.test(value); }
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
}
async function existingFile(path: string) {
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (info && !info.isFile()) throw new Error('Attachment original is not a regular file.');
  return info;
}
function safeName(value: string) {
  let name = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'attachment';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  if (name.length > 180) name = name.slice(0, 150) + extname(name).slice(0, 30);
  return name;
}
