import fs from 'node:fs';
import path from 'node:path';

export type ExecutableInspection =
  | { status: 'available'; executable: string }
  | { status: 'missing' | 'invalid' | 'inaccessible'; code?: string };

function environment(env: NodeJS.ProcessEnv, name: string) {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function failure(error: unknown): ExecutableInspection {
  const code = (error as NodeJS.ErrnoException).code;
  return { status: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible', ...(code ? { code } : {}) };
}

/** Resolve Windows application execution aliases to their actual binary. A Store
 * alias can be launchable while stat(alias) fails with EACCES. Only inspect links
 * in the current account's alias directory, then apply normal checks to the target.
 * No subprocess, permission changes, directory scan, or generic EACCES bypass.
 */
export function inspectExecutableFile(file: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ExecutableInspection {
  const inspect = (candidate: string): ExecutableInspection => {
    try {
      if (!fs.statSync(candidate).isFile()) return { status: 'invalid' };
      fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return { status: 'available', executable: candidate };
    } catch (error) { return failure(error); }
  };
  const local = platform === 'win32' ? environment(env, 'LOCALAPPDATA') : undefined;
  const aliasDirectory = local && path.win32.isAbsolute(local) ? path.win32.join(local, 'Microsoft', 'WindowsApps') : undefined;
  if (aliasDirectory && path.win32.isAbsolute(file) && path.win32.extname(file).toLowerCase() === '.exe'
    && path.win32.dirname(path.win32.normalize(file)).toLowerCase() === aliasDirectory.toLowerCase()) {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (!path.win32.isAbsolute(target) || path.win32.basename(target).toLowerCase() !== path.win32.basename(file).toLowerCase()) {
          return { status: 'invalid' };
        }
        return inspect(target);
      }
    } catch (error) { return failure(error); }
  }
  return inspect(file);
}
