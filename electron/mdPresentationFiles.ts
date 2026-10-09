import { createHash, randomUUID } from 'node:crypto';
import { open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

export type MarkdownFile = { path: string; text: string; revision: string };
export type MarkdownFileRequest = { action: 'open' | 'reload' | 'save'; path?: string; text?: string; revision?: string; name?: string };
const limit = 2 * 1024 * 1024;
const revision = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');

/** Access is scoped to files explicitly selected in this application session. */
export class MarkdownFiles {
  private readonly granted = new Set<string>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly choose: (mode: 'open' | 'save', name?: string) => Promise<string | undefined>) {}
  private path(value: string) {
    if (!isAbsolute(value) || !['.md', '.markdown'].includes(extname(value).toLowerCase())) throw Error('请选择 Markdown 文件（.md）。');
    return resolve(value);
  }
  private async read(path: string): Promise<MarkdownFile> {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > limit) throw Error('Markdown 文件不能超过 2 MB。');
      const buffer = Buffer.alloc(limit + 1); let length = 0;
      while (length < buffer.length) { const chunk = await file.read(buffer, length, buffer.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
      if (length > limit) throw Error('Markdown 文件不能超过 2 MB。');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
      return { path, text, revision: revision(buffer.subarray(0, length)) };
    } finally { await file.close(); }
  }
  command(input: MarkdownFileRequest): Promise<MarkdownFile | null> {
    const task = this.pending.then(() => this.execute(input)); this.pending = task.catch(() => {}); return task;
  }
  private async execute(input: MarkdownFileRequest): Promise<MarkdownFile | null> {
    if (!input || !['open', 'save', 'reload'].includes(input.action)) throw Error('Unknown Markdown file action.');
    if (input.action === 'open') {
      const chosen = await this.choose('open'); if (!chosen) return null;
      const path = this.path(chosen), result = await this.read(path); this.granted.add(path); return result;
    }
    if (input.path && !this.granted.has(this.path(input.path))) throw Error('请先选择要编辑的 Markdown 文件。');
    if (input.action === 'reload') {
      if (!input.path) throw Error('请选择 Markdown 文件。');
      return this.read(this.path(input.path));
    }
    if (typeof input.text !== 'string' || Buffer.byteLength(input.text, 'utf8') > limit) throw Error('Markdown 文件不能超过 2 MB。');
    const chosen = input.path || await this.choose('save', input.name); if (!chosen) return null;
    const path = this.path(chosen);
    const previous = await this.read(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (input.path && (previous === undefined || previous.revision !== input.revision)) throw Error('文件已在外部修改。请重新载入，或另存为以保留当前修改。');
    const mode = await stat(path).then(info => info.mode).catch(() => 0o600);
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, input.text, { flag: 'wx', mode });
      // Recheck before replacement, including files changed while a save dialog was open.
      const latest = await this.read(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (latest?.revision !== previous?.revision) throw Error('文件在保存期间被修改，请重新载入后再保存。');
      await rename(temporary, path); this.granted.add(path);
      return { path, text: input.text, revision: revision(input.text) };
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
