import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative } from 'node:path';
import yauzl from 'yauzl';
import { fork } from 'node:child_process';
import { z } from 'zod';
import { normalizeWebImage } from '@cardbush/bush-runtime/web-policy';
import { agentFileRead, agentFileUpload } from './agentFiles.mjs';

const limit = 16 * 1024 * 1024;
const uuid = z.string().uuid();
type Attachment = { id: string; path: string; name: string; size: number; mime: string; textPath?: string };
function extractDocument(path: string): Promise<string> {
  return new Promise(resolve => {
    const child = fork(new URL('./agentWebDocument.mjs', import.meta.url), [path], { execArgv: ['--max-old-space-size=128'], stdio: ['ignore','ignore','ignore','ipc'], env: { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot } });
    let settled = false;
    const finish = (text: string) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); resolve(text); };
    const timer = setTimeout(() => finish('文档提取超时。请提供相关段落或图片，不能声称已读取全文。'), 12000);
    child.once('message', value => finish(String((value as { text?: string }).text ?? '').slice(0, 300000)));
    child.once('error', () => finish('文档提取失败，请提供文本或图片。'));
    child.once('exit', () => finish('文档提取失败，请提供文本或图片。'));
  });
}
export async function validateWebDocument(bytes: Buffer, name: string): Promise<string> {
  const ext = extname(name).toLowerCase();
  if (bytes.subarray(4, 8).toString() === 'ftyp' || /^(FLV|OggS)/.test(bytes.subarray(0, 4).toString()) || bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) || bytes.subarray(8, 12).toString() === 'AVI ') throw new Error('不支持视频上传。');
  if (['.txt', '.md', '.csv', '.tsv', '.json', '.log'].includes(ext)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('文件内容不是有效文本。');
    return 'text/plain';
  }
  if (ext === '.pdf' && bytes.subarray(0, 5).toString() === '%PDF-' && !/\/(?:RichMedia|EmbeddedFile|Movie|JavaScript|Launch)\b/.test(bytes.toString('latin1'))) return 'application/pdf';
  if (['.docx', '.xlsx', '.pptx'].includes(ext)) {
    await new Promise<void>((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(new Error('文档格式无效。')); return; }
      let total = 0, count = 0, types = false, main = false;
      zip.on('error', reject);
      zip.on('entry', entry => {
        total += entry.uncompressedSize; count++;
        const path = entry.fileName;
        if (total > 64 * 1024 * 1024 || count > 4000 || /(?:^|\/)\.\.(?:\/|$)|\\|(?:^|\/)(?:embeddings|vbaProject|activeX)(?:\/|\.)|\.(?:mp4|mov|webm|avi|mkv|m4v|wmv|flv|mpeg|mpg|ts|exe|dll|bin)$/i.test(path) || (entry.generalPurposeBitFlag & 1)) { zip.close(); reject(new Error('不接受含视频、嵌入对象或宏的文档。')); return; }
        types ||= path === '[Content_Types].xml';
        main ||= path === ({ '.docx': 'word/document.xml', '.xlsx': 'xl/workbook.xml', '.pptx': 'ppt/presentation.xml' } as Record<string,string>)[ext];
        zip.readEntry();
      });
      zip.on('end', () => types && main ? resolve() : reject(new Error('文档格式与后缀不符。'))); zip.readEntry();
    }));
    return 'application/octet-stream';
  }
  throw new Error('支持 PNG/JPG/WebP 图片、文本、PDF、DOCX、XLSX、PPTX；不支持视频。');
}

/** The staging area and manifest are outside the model-readable personal folders. */
export class AgentWebFiles {
  #uploads: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}
  async describe(path: string): Promise<Attachment> {
    const personal = await realpath(join(this.root, 'workspaces'));
    const candidate = await realpath(isAbsolute(path) ? path : join(personal, path));
    const rel = relative(personal, candidate);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Access outside personal files denied.');
    const info = await stat(candidate);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('File unavailable.');
    return { id: '', path: candidate, name: basename(candidate), size: info.size, mime: ['.png','.jpg','.jpeg','.webp'].includes(extname(candidate).toLowerCase()) ? `image/${extname(candidate).toLowerCase() === '.png' ? 'png' : extname(candidate).toLowerCase() === '.webp' ? 'webp' : 'jpeg'}` : 'application/octet-stream' };
  }
  async attachment(id: string): Promise<Attachment> {
    const value = JSON.parse(await readFile(join(this.root, 'config', 'files', uuid.parse(id) + '.json'), 'utf8')) as Attachment;
    await this.describe(value.path); return value;
  }
  call(input: Record<string, unknown>): Promise<unknown> {
    if (input.action !== 'upload') return this.#call(input);
    const result = this.#uploads.then(() => this.#call(input));
    this.#uploads = result.catch(() => undefined); return result;
  }
  async #call(input: Record<string, unknown>) {
    if (input.action === 'describe') return input.id ? this.attachment(String(input.id)) : this.describe(String(input.path));
    if (input.action === 'read') {
      const value = await this.describe(String(input.path));
      return { ...await agentFileRead(join(this.root, 'workspaces'), { path: value.path, offset: input.offset }), mime: value.mime };
    }
    if (input.action !== 'upload') throw new Error('Unknown file operation.');
    const value = z.object({ action: z.literal('upload'), uploadId: uuid, name: z.string().min(1).max(160).regex(/^[^/\\\x00-\x1f:]+$/), offset: z.number().int().min(0).max(limit), content: z.string().max(710_000), size: z.number().int().min(1).max(limit), done: z.boolean() }).strict().parse(input);
    const completed = await this.attachment(value.uploadId).catch(() => null);
    if (completed) return { nextOffset: value.size, attachment: completed };
    if (value.offset + Buffer.from(value.content, 'base64').length > value.size) throw new Error('Upload size mismatch.');
    const stage = join(this.root, 'upload-staging'); await mkdir(stage, { recursive: true });
    const result = await agentFileUpload(stage, value);
    if (!value.done) return { nextOffset: result.nextOffset };
    if (result.nextOffset !== value.size || (await stat(result.path)).size !== value.size) throw new Error('Upload is incomplete.');
    let bytes = await readFile(result.path), name = value.name, mime: string;
    try {
      if (/\.(png|jpe?g|webp)$/i.test(name)) {
        bytes = Buffer.from(await normalizeWebImage(bytes)); name = name.replace(/\.[^.]+$/, '.png'); mime = 'image/png';
      } else mime = await validateWebDocument(bytes, name);
    } catch (error) { await rm(result.path, { force: true }); throw error; }
    const target = join(this.root, 'workspaces', 'uploads', value.uploadId); await mkdir(target, { recursive: true });
    const path = join(target, name);
    await writeFile(result.path, bytes, { mode: 0o600 }); await rename(result.path, path);
    const attachment: Attachment = { id: value.uploadId, path, name, mime, size: bytes.length };
    if (/\.(pdf|docx|xlsx|pptx)$/i.test(name)) {
      attachment.textPath = path + '.extracted.txt';
      await writeFile(attachment.textPath, await extractDocument(path), { mode: 0o600 });
    }
    const manifests = join(this.root, 'config', 'files'); await mkdir(manifests, { recursive: true });
    await writeFile(join(manifests, value.uploadId + '.json'), JSON.stringify(attachment), { mode: 0o600 });
    return { nextOffset: value.size, attachment };
  }
}
