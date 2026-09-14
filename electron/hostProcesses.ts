import type { WebContents } from 'electron';
import type { ManagedCommandOptions, ManagedProcessOptions, ManagedProcessScope } from '@cardbush/bush-runtime/processes' with { 'resolution-mode': 'import' };

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
