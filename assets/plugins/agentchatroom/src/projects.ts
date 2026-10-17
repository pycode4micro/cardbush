import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { RuntimeConversation } from '@cardbush/bush-runtime';

const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
/** Source projects and their worktrees share a coordination scope, without changing their write roots. */
export async function projectKey(fact: RuntimeConversation): Promise<string> {
  const root = fact.projectDir || fact.workspaceDir;
  if (!root) return `session:${fact.agentId}`;
  if (root.startsWith('ssh://')) return root.replace(/\/+$/, '');
  const actual = await realpath(root).catch(() => resolve(root));
  for (let dir = actual, depth = 0; depth < 32; depth++, dir = dirname(dir)) {
    try {
      let git = join(dir, '.git');
      if ((await stat(git)).isFile()) {
        const match = /^gitdir:\s*(.+)/m.exec(await readFile(git, 'utf8'));
        if (!match) break;
        git = resolve(dir, match[1]!.trim());
      }
      const common = await readFile(join(git, 'commondir'), 'utf8').catch(() => '.');
      return `git:${canonical(await realpath(resolve(git, common.trim())))}`;
    } catch { /* A normal folder, or a git marker that cannot be inspected. */ }
    if (dirname(dir) === dir) break;
  }
  return `directory:${canonical(actual)}`;
}
