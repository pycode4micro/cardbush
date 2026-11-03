import { rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from 'node:module';
import { secureConfigDirectory } from '@cardbush/platform/credentials';

const { lock } = createRequire(import.meta.url)('proper-lockfile') as {
  lock(path: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
};

const fileOperations = new Map<string, Promise<void>>();

/** Serialize read/modify/replace transactions, including separate store instances. */
export function withConfigFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const absolute = resolve(path);
  const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const result = (fileOperations.get(key) ?? Promise.resolve()).then(async () => {
    secureConfigDirectory(dirname(absolute));
    let compromised: Error | undefined;
    const release = await lock(absolute, { realpath: false, stale: 30_000, update: 5_000,
      retries: { retries: 100, factor: 1, minTimeout: 100, maxTimeout: 100 },
      onCompromised: (error: Error) => { compromised = error; } });
    try {
      const value = await operation();
      if (compromised) throw compromised;
      return value;
    } finally { await release(); }
  });
  const settled = result.then(() => undefined, () => undefined);
  fileOperations.set(key, settled);
  void settled.then(() => { if (fileOperations.get(key) === settled) fileOperations.delete(key); });
  return result;
}

export async function replaceFile(temporary: string, target: string): Promise<void> {
  try {
    await rename(temporary, target);
    return;
  } catch (error) {
    if (!replaceConflict(error)) throw error;
  }
  const backup = `${target}.${process.pid}.${crypto.randomUUID()}.bak`;
  let movedExisting = false;
  try {
    await rename(target, backup);
    movedExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    if (movedExisting) await rename(backup, target).catch(() => undefined);
    throw error;
  }
  if (movedExisting) await rm(backup, { force: true });
}

function replaceConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}
