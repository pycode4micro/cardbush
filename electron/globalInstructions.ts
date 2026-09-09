import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AgentInstructionDocument } from '@cardbush/bush-product-agent' with { 'resolution-mode': 'import' };

export interface GlobalInstructionsSnapshot {
  path: string;
  content: string;
  revision: string;
}

/** AGENTS.md is the only persisted source; settings and new turns read this file. */
export class GlobalInstructionsStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(): Promise<GlobalInstructionsSnapshot> {
    const bytes = await readFile(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    });
    return {
      path: this.path,
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      revision: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  save(content: string, expectedRevision: string): Promise<GlobalInstructionsSnapshot> {
    const operation = this.writes.then(async () => {
      if (typeof content !== 'string' || typeof expectedRevision !== 'string') {
        throw new Error('Invalid global instructions.');
      }
      const current = await this.read();
      if (current.revision !== expectedRevision) {
        throw new Error('AGENTS.md 已在其他位置修改，请重新读取后再保存。 / AGENTS.md changed; reload it before saving.');
      }
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { encoding: 'utf-8', flag: 'wx' });
        await rename(temporary, this.path);
      } finally {
        await rm(temporary, { force: true });
      }
      return this.read();
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
}

/** Global rules first, then ancestor rules from the root to the active directory.
 * Deeper, unrelated subtrees are not read or promoted into the whole project.
 */
export async function readAgentInstructionDocuments(
  global: GlobalInstructionsStore,
  projectDir?: string,
  workspaceDir?: string,
): Promise<AgentInstructionDocument[]> {
  const snapshot = await global.read();
  const documents: AgentInstructionDocument[] = snapshot.content.trim()
    ? [{ path: snapshot.path, scope: 'global', content: snapshot.content }]
    : [];
  if (!projectDir?.trim()) return documents;
  const activeDirectory = workspaceDir?.trim() || projectDir.trim();
  if (!isAbsolute(activeDirectory)) throw new Error('Instruction directory must be an absolute path.');
  const directories: string[] = [];
  for (let current = resolve(activeDirectory); ; current = dirname(current)) {
    directories.unshift(current);
    if (dirname(current) === current) break;
  }
  const identity = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  for (const directory of directories) {
    const path = join(directory, 'AGENTS.md');
    if (identity(path) === identity(snapshot.path)) continue;
    const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!bytes) continue;
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (content.trim()) documents.push({ path, scope: 'directory', directory, content });
  }
  return documents;
}
