import { constants, accessSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { isWithin } from './workspaceAccessPolicy.js';
import { hostEnvironmentValue } from './hostEnvironment.js';

/** Resolve on the host before spawning. Never ask the OS to search cwd, a
 * relative PATH entry, a shell shim, or the repository being inspected. */
export async function trustedGit(roots: readonly string[] = []): Promise<string> {
  return trustedGitSync(roots);
}

export function trustedGitSync(roots: readonly string[] = []): string {
  const configured = hostEnvironmentValue('CARDBUSH_GIT_PATH')?.trim();
  const paths = configured ? [configured] : (hostEnvironmentValue('PATH') ?? '').split(delimiter)
    .map(path => path.trim().replace(/^"|"$/g, '')).filter(isAbsolute)
    .map(path => join(path, process.platform === 'win32' ? 'git.exe' : 'git'));
  const untrusted = [process.cwd(), ...roots].map(path => { try { return realpathSync(path); } catch { return path; } });
  for (const path of paths) {
    if (!isAbsolute(path) || path.startsWith('\\\\') || path.includes('\0')) continue;
    try {
      const executable = realpathSync(path);
      if (untrusted.some(root => isWithin(root, executable)) || process.platform === 'win32' && !/^[a-z]:\\.*\.exe$/i.test(executable)) continue;
      if (!statSync(executable).isFile()) continue;
      accessSync(executable, constants.X_OK);
      return executable;
    } catch { /* A missing candidate is never executed. Explicit configuration has no fallback. */ }
  }
  throw Object.assign(Error('No trusted Git executable is available. Install Git outside the workspace or configure an absolute CARDBUSH_GIT_PATH; no Git command was started.'), { code: 'git_unavailable' });
}
