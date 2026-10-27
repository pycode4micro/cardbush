import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

export function connectorDataRoot(userDataPath: string, nativeHostPath: string, msixPackage: boolean): string {
  if (!msixPackage) return userDataPath;
  const result = JSON.parse(execFileSync(nativeHostPath, ['--package-data-root'], {
    windowsHide: true, encoding: 'utf8', timeout: 10_000,
  }));
  if (typeof result.path !== 'string' || !path.isAbsolute(result.path) || path.basename(result.path) !== 'LocalState') {
    throw new Error('The connector package data directory could not be verified.');
  }
  fs.mkdirSync(result.path, { recursive: true });
  return result.path;
}

export function connectorDirectory(userDataPath: string): string {
  const directory = path.join(userDataPath, 'browser-connector');
  const root = fs.realpathSync.native(userDataPath);
  if (fs.existsSync(directory)) {
    if (fs.lstatSync(directory).isSymbolicLink()
      || path.dirname(fs.realpathSync.native(directory)).toLowerCase() !== root.toLowerCase()) {
      throw new Error('Connector directory must belong to this installation (no redirected directories).');
    }
  }
  return directory;
}

export function assertConnectorFile(file: string): void {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('Connector configuration must be a regular, unshared file.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function writeConnectorFile(file: string, content: string): void {
  assertConnectorFile(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function secureConnectorResource(nativeHostPath: string, kind: 'directory' | 'pipe', target: string): void {
  if (process.platform !== 'win32') return;
  // The signed native host applies and verifies a current-user + SYSTEM DACL.
  // This is a fixed internal operation, never a renderer-supplied command.
  execFileSync(nativeHostPath, [`--secure-${kind}`, target], {
    windowsHide: true, encoding: 'utf8', timeout: 10_000,
  });
}

/** The fixed helper has completed its ACL write AND verification when it exits.
 * Concurrent Windows worker launches can retain a duplicate output-pipe handle;
 * execFile then waits for EOF until its timeout even after exit code 0. Do not
 * make readiness depend on another process releasing that unrelated handle. */
export async function secureConnectorResourceAsync(nativeHostPath: string, kind: 'directory' | 'pipe', target: string): Promise<void> {
  if (process.platform !== 'win32') return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(nativeHostPath, [`--secure-${kind}`, target], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let settled = false, diagnostic = '';
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); child.stderr.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`Private IPC ${kind} permission verification timed out.`)); }, 10_000);
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
    child.once('error', finish);
    child.once('exit', (code, signal) => finish(code === 0 && !signal ? undefined
      : new Error(diagnostic.trim() || `Private IPC ${kind} permission verification failed (${signal ?? code}).`)));
  });
}
