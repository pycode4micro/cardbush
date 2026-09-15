import type { WebContents } from 'electron';
import type { ManagedCommandOptions, ManagedProcessOptions, ManagedProcessScope, ProcessResourceLease } from '@cardbush/bush-runtime/processes' with { 'resolution-mode': 'import' };

let loading: Promise<typeof import('@cardbush/bush-runtime/processes', { with: { 'resolution-mode': 'import' } })> | undefined;
let scope: ManagedProcessScope | undefined;
let closed = false;
const owners = new WeakMap<WebContents, { controller: AbortController }>();

async function processes() {
  if (closed) throw new DOMException('CardBush is shutting down.', 'AbortError');
  const module = await (loading ??= import('@cardbush/bush-runtime/processes'));
  if (closed) throw new DOMException('CardBush is shutting down.', 'AbortError');
  scope ??= new module.ManagedProcessScope();
  return { module, scope };
}

/** A renderer reload/crash/close releases its terminals, without affecting other windows. */
export function processOwnerSignal(owner: WebContents): AbortSignal {
  let state = owners.get(owner);
  if (!state) {
    state = { controller: new AbortController() };
    owners.set(owner, state);
    const release = () => state!.controller.abort();
    owner.once('destroyed', release);
    owner.on('render-process-gone', release);
    owner.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) release();
    });
  }
  if (state.controller.signal.aborted) state.controller = new AbortController();
  if (owner.isDestroyed()) state.controller.abort();
  return state.controller.signal;
}

export async function spawnHostProcess(input: ManagedProcessOptions) {
  return (await processes()).scope.spawn(input);
}

export async function runHostCommand(input: Omit<ManagedCommandOptions, 'scope'>) {
  const { module, scope } = await processes();
  return module.runResourceManagedCommand({ ...input, scope });
}

export async function closeHostProcesses() {
  closed = true; // Blocks launches that are still waiting for the dynamic import.
  await scope?.close();
}

export async function setHostApplicationMemoryProvider(provider: () => number, relieve?: () => boolean): Promise<void> {
  (await processes()).module.getProcessResourceGovernor().setApplicationMemoryProvider(provider, relieve);
}

/** Private ownership of Runtime admissions, using the SAME governor as main-process helpers. */
export class HostProcessResourceOwner {
  readonly #claims = new Map<string, { lease?: ProcessResourceLease }>();
  #closed = false;

  async handle(operation: 'resources.acquire' | 'resources.release', payload: unknown, signal: AbortSignal): Promise<unknown> {
    const input = payload as { id?: string; lifetime?: string; replace?: string };
    if (!input || typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.id)) throw new Error('Invalid resource admission identity.');
    if (operation === 'resources.release') {
      this.#claims.get(input.id)?.lease?.release();
      this.#claims.delete(input.id);
      return;
    }
    signal.throwIfAborted();
    if (this.#closed || this.#claims.has(input.id) || this.#claims.size >= 256) throw new Error('Resource owner is closed or its admission is invalid.');
    if (input.lifetime !== 'task' && input.lifetime !== 'service') throw new Error('Invalid resource lifetime.');
    const claim: { lease?: ProcessResourceLease } = {};
    this.#claims.set(input.id, claim);
    try {
      const { module } = await processes();
      signal.throwIfAborted();
      if (this.#closed || this.#claims.get(input.id) !== claim) throw new DOMException('Resource admission cancelled.', 'AbortError');
      const replace = [...this.#claims.values()].some(value => value.lease?.id === input.replace) ? input.replace : undefined;
      const lease = module.getProcessResourceGovernor().acquire(input.lifetime, replace);
      claim.lease = lease;
      const { release: _release, ...grant } = lease;
      return grant;
    } catch (error) { this.#claims.delete(input.id); throw error; }
  }

  close(): void {
    this.#closed = true;
    // The native guard observes the pinned Runtime handle and terminates its
    // tree within two seconds. Keep reservations until that cleanup has run.
    const claims = [...this.#claims.values()]; this.#claims.clear();
    const timer = setTimeout(() => claims.forEach(claim => claim.lease?.release()), 3_000);
    timer.unref();
  }
}
