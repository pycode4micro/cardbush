import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ModelPreviewMetadata = {
  blenderVersion: string;
  scene: string;
  scenes: string[];
  frameStart: number;
  frameEnd: number;
  fps: number;
  objects: number;
  materials: number;
  issues: Array<{ code: string; count: number; examples: string[] }>;
};

export class ModelPreviewError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

async function isFile(file: string) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

export async function findBlenderExecutable(env = process.env): Promise<string | null> {
  if (env.CARDBUSH_BLENDER_PATH) return await isFile(env.CARDBUSH_BLENDER_PATH) ? env.CARDBUSH_BLENDER_PATH : null;
  const executable = process.platform === 'win32' ? 'blender.exe' : 'blender';
  const candidates = (env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir.replace(/^"|"$/g, ''), executable));
  if (process.platform === 'darwin') candidates.push('/Applications/Blender.app/Contents/MacOS/Blender');
  if (process.platform === 'win32') {
    const roots = [
      env.ProgramFiles && path.join(env.ProgramFiles, 'Blender Foundation'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Blender'),
    ].filter((value): value is string => !!value);
    for (const root of roots) {
      candidates.push(path.join(root, executable));
      try {
        const entries = (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory())
          .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
        candidates.push(...entries.map(entry => path.join(root, entry.name, executable)));
      } catch { /* Optional install location. */ }
    }
  }
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return null;
}

/** Conversion runs in Blender, never in the app renderer. All writes stay in a unique temp directory. */
export class ModelPreviewService {
  private root: Promise<string> | undefined;
  private readonly jobs = new Map<string, AbortController>();
  private readonly resources = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly released = new Map<string, number>();
  private disposed = false;

  constructor(private readonly options: { scriptPath: string; executable?: string; timeoutMs?: number; tempRoot?: string }) {}

  private getRoot() {
    return this.root ??= fs.mkdtemp(path.join(this.options.tempRoot ?? os.tmpdir(), 'cardbush-model-preview-'))
      .catch(error => { this.root = undefined; throw error; });
  }

  async preview(file: string, scene = '', signal?: AbortSignal, id: string = randomUUID()) {
    if (this.disposed || signal?.aborted) throw new ModelPreviewError('cancelled', 'Preview cancelled.');
    if (!validPreviewId(id)) throw new ModelPreviewError('invalid_request', 'Invalid preview request id.');
    this.pruneReleased();
    if (this.released.has(id)) throw new ModelPreviewError('cancelled', 'Preview cancelled.');
    if (this.jobs.has(id) || this.resources.has(id)) throw new ModelPreviewError('duplicate_request', 'This preview request is already in use.');
    if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.blend') {
      throw new ModelPreviewError('unsupported', 'This preview adapter accepts .blend files only.');
    }
    if (this.jobs.size >= 2) throw new ModelPreviewError('busy', 'Two model previews are already being prepared. Please retry shortly.');
    const controller = new AbortController();
    // Reserve the request before any I/O so an explicit release can cancel startup too.
    this.jobs.set(id, controller);
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let root: string | undefined;
    let directory: string | undefined;
    try {
      const before = await fs.stat(file);
      if (!before.isFile()) throw new ModelPreviewError('not_file', 'Preview target is not a file.');
      const executable = this.options.executable ?? await findBlenderExecutable();
      if (!executable) throw new ModelPreviewError('blender_missing', 'Blender is not installed or its executable could not be found.');
      if (controller.signal.aborted) throw new ModelPreviewError('cancelled', 'Preview cancelled.');
      root = await this.getRoot();
      directory = path.join(root, id);
      await fs.mkdir(directory);
      // An executable cannot read scripts inside an Electron asar archive.
      const script = path.join(directory, 'preview.py');
      await fs.writeFile(script, await fs.readFile(this.options.scriptPath));
      await runBlender(executable, script, file, directory, scene, controller.signal, this.options.timeoutMs ?? 120_000);
      const after = await fs.stat(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new ModelPreviewError('changed', 'The source file changed during conversion. Please reload its preview.');
      }
      const output = path.join(directory, 'scene.glb');
      const size = (await fs.stat(output)).size;
      if (size > 128 * 1024 * 1024) throw new ModelPreviewError('too_large', 'The converted scene exceeds the 128 MiB interactive preview limit.');
      const metadataPath = path.join(directory, 'metadata.json');
      if ((await fs.stat(metadataPath)).size > 512 * 1024) throw new ModelPreviewError('too_large', 'Scene metadata is too large to display.');
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as ModelPreviewMetadata;
      if (!Array.isArray(metadata.scenes) || typeof metadata.scene !== 'string' || !Array.isArray(metadata.issues)) {
        throw new ModelPreviewError('conversion', 'Blender returned invalid preview metadata.');
      }
      if (controller.signal.aborted) throw new ModelPreviewError('cancelled', 'Preview cancelled.');
      this.resources.set(id, output);
      const timer = setTimeout(() => { void this.release(id); }, 5 * 60_000);
      timer.unref();
      this.timers.set(id, timer);
      return { id, metadata, size };
    } catch (error) {
      if (directory) await this.removeDirectory(directory);
      if (controller.signal.aborted) throw new ModelPreviewError('cancelled', 'Preview cancelled.');
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.jobs.delete(id);
      if (this.disposed && this.jobs.size === 0 && root) await this.removeDirectory(root, true);
    }
  }

  resource(id: string) { return this.resources.get(id); }

  async release(id: string) {
    if (!validPreviewId(id)) return;
    this.pruneReleased();
    this.released.set(id, Date.now());
    this.jobs.get(id)?.abort();
    const file = this.resources.get(id);
    if (!file) return;
    this.resources.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    await this.removeDirectory(path.dirname(file));
  }

  private pruneReleased() {
    for (const [id, releasedAt] of this.released) {
      if (Date.now() - releasedAt > 30_000 || this.released.size >= 256) this.released.delete(id);
    }
  }

  async dispose() {
    this.disposed = true;
    for (const controller of this.jobs.values()) controller.abort();
    for (const id of this.resources.keys()) await this.release(id);
    // Pending jobs remove their own directories after their process exits.
    const root = await this.root?.catch(() => undefined);
    if (this.jobs.size === 0 && root) await this.removeDirectory(root, true);
  }

  private async removeDirectory(directory: string, rootItself = false) {
    const root = path.resolve(await this.getRoot());
    const relative = path.relative(root, path.resolve(directory));
    if ((!relative && !rootItself) || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid preview cleanup path.');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

function validPreviewId(id: string) { return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id); }

async function runBlender(executable: string, script: string, file: string, directory: string, scene: string, signal: AbortSignal, timeoutMs: number) {
  if (signal.aborted) throw new ModelPreviewError('cancelled', 'Preview cancelled.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['--background', '--factory-startup', '--disable-autoexec', '--threads', '2',
      '--python-exit-code', '1', '--python', script, '--', file, directory, '--scene', scene], {
      windowsHide: true, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONNOUSERSITE: '1' },
    });
    let tail = '';
    let timedOut = false;
    const record = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-6000); };
    child.stdout.on('data', record);
    child.stderr.on('data', record);
    const cancel = () => { child.kill(); };
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    child.on('error', error => { clean(); reject(error); });
    child.on('close', code => {
      clean();
      if (signal.aborted) reject(new ModelPreviewError('cancelled', 'Preview cancelled.'));
      else if (timedOut) reject(new ModelPreviewError('timeout', 'Blender preview conversion timed out.'));
      else if (code !== 0) reject(new ModelPreviewError('conversion', `Blender could not prepare this scene (exit ${code}).\n${tail}`));
      else resolve();
    });
    if (signal.aborted) cancel();
  });
}
