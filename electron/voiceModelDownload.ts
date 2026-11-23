import { NativeVoiceError } from './voiceUiError';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { VoiceModelFile } from './voiceModelManifest';

export interface VoiceDownload { url: string; bytes: number; sha256: string }
const downloadHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
export async function downloadVoiceFile(asset: VoiceDownload, destination: string, fetcher: typeof fetch, signal: AbortSignal, progress: (bytes: number) => void) {
  let url = asset.url, response: Response | undefined;
  for (let redirects = 0; redirects < 6; redirects++) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || !downloadHosts.has(target.hostname)) throw new NativeVoiceError('voiceNative.downloadUntrusted');
    try { response = await fetcher(url, { signal, redirect: 'manual', credentials: 'omit' }); }
    catch {
      signal.throwIfAborted();
      throw new NativeVoiceError('voiceNative.downloadNetwork');
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new NativeVoiceError('voiceNative.downloadInvalidRedirect');
    url = new URL(location, url).href; response = undefined;
  }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel();
    if (response) throw new NativeVoiceError('voiceNative.downloadHttp', { status: response.status });
    throw new NativeVoiceError('voiceNative.downloadRedirectLimit');
  }
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== asset.bytes) { await response.body.cancel(); throw new NativeVoiceError('voiceNative.downloadSizeMismatch'); }
  await pipeline(Readable.fromWeb(response.body as never), integrityStream(asset, progress), fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
}

export function integrityStream(expected: Pick<VoiceDownload, 'bytes' | 'sha256'>, progress = (_bytes: number) => {}) {
  const hash = createHash('sha256'); let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > expected.bytes) { callback(new NativeVoiceError('voiceNative.modelFileTooLarge')); return; }
      hash.update(chunk); progress(bytes); callback(null, chunk);
    },
    flush(callback) { callback(bytes !== expected.bytes || hash.digest('hex') !== expected.sha256 ? new NativeVoiceError('voiceNative.modelChecksum') : undefined); },
  });
}

/** Extract one fixed entry to stdout, never let archive paths create files or links. */
export async function extractVoiceFile(archive: string, entry: string, destination: string, expected: Pick<VoiceDownload, 'bytes' | 'sha256'>, signal: AbortSignal) {
  if (!/^[a-zA-Z0-9_.\-/]+$/.test(entry) || entry.startsWith('/') || entry.split('/').some(part => part === '..')) throw Error('Invalid model archive entry.');
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
  const child = spawn(tar, ['-xOf', archive, entry], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'], signal, timeout: 120_000 });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new NativeVoiceError('voiceNative.tarUnavailable')));
    child.once('close', code => code === 0 ? resolve() : reject(new NativeVoiceError('voiceNative.modelUnpackFailed')));
  });
  try {
    await Promise.all([exited, pipeline(child.stdout, integrityStream(expected), fs.createWriteStream(destination, { flags: 'wx', mode: 0o700 }), { signal })]);
  } catch (error) { child.kill(); await exited.catch(() => {}); throw error; }
}

export async function verifyVoiceFile(file: string, expected: Pick<VoiceDownload, 'bytes' | 'sha256'>) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes) throw new NativeVoiceError('voiceNative.modelFileIncomplete');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== expected.sha256) throw new NativeVoiceError('voiceNative.modelFileInvalid');
}

/** One pass over a verified archive; tar never writes paths, links or executable hooks.
 * The pinned manifest includes EVERY regular file in archive order. */
export async function extractVoiceFiles(archive: string, directory: string, files: VoiceModelFile[], signal: AbortSignal) {
  const destinations = new Set<string>();
  for (const file of files) {
    const target = path.resolve(directory, file.name);
    if (!file.name || !/^[a-zA-Z0-9_! .\-/]+$/.test(file.name) || file.name.split('/').some(part => !part || part === '.' || /[. ]$/.test(part)) ||
      !target.startsWith(path.resolve(directory) + path.sep) || destinations.has(target.toLowerCase())) throw Error('Invalid model destination.');
    destinations.add(target.toLowerCase());
  }
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
  const child = spawn(tar, ['-xOf', archive], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'], signal, timeout: 120_000 });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new NativeVoiceError('voiceNative.modelUnpackUnavailable')));
    child.once('close', code => code === 0 ? resolve() : reject(new NativeVoiceError('voiceNative.modelUnpackFailed')));
  });
  void exited.catch(() => {});
  let index = 0, offset = 0, handle: fs.promises.FileHandle | undefined, hash = createHash('sha256');
  const open = async () => {
    const target = path.join(directory, files[index].name);
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    handle = await fs.promises.open(target, 'wx', 0o600);
  };
  const finish = async () => {
    if (hash.digest('hex') !== files[index].sha256) throw new NativeVoiceError('voiceNative.modelChecksum');
    await handle?.close(); handle = undefined; index++; offset = 0; hash = createHash('sha256');
  };
  try {
    for await (const raw of child.stdout) {
      signal.throwIfAborted(); const chunk = Buffer.from(raw); let cursor = 0;
      while (cursor < chunk.length) {
        if (index >= files.length) throw new NativeVoiceError('voiceNative.modelArchiveTooLarge');
        if (!handle) await open();
        const count = Math.min(chunk.length - cursor, files[index].bytes - offset);
        const part = chunk.subarray(cursor, cursor + count); hash.update(part);
        let written = 0;
        while (written < count) { const result = await handle!.write(part, written, count - written); if (!result.bytesWritten) throw new NativeVoiceError('voiceNative.modelWriteFailed'); written += result.bytesWritten; }
        offset += count; cursor += count;
        if (offset === files[index].bytes) await finish();
      }
    }
    while (index < files.length && files[index].bytes === 0) { await open(); await finish(); }
    await exited; signal.throwIfAborted();
    if (index !== files.length || offset) throw new NativeVoiceError('voiceNative.modelArchiveIncomplete');
  } catch (error) { child.kill(); await exited.catch(() => {}); throw error; }
  finally { await handle?.close(); }
}
