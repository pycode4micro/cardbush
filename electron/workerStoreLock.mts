import { createRequire } from 'node:module';

const { lock } = createRequire(import.meta.url)('proper-lockfile') as {
  lock(path: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
};

/** A bounded, crash-recoverable lock shared by App and CLI processes. */
export async function withWorkerStoreLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  let compromised: Error | undefined;
  const release = await lock(path, { realpath: false, stale: 30_000, update: 5_000,
    retries: { retries: 100, factor: 1, minTimeout: 100, maxTimeout: 100 },
    onCompromised: (error: Error) => { compromised = error; } });
  try {
    const value = await action();
    if (compromised) throw compromised;
    return value;
  } finally { await release(); }
}
