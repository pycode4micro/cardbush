import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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
