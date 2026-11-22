import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RoomStore } from './vendor/store.js';

export type Membership = { token: string; participant: string; cursor: string; after: number; project: string; active: boolean;
  turnId?: string };
export type Room = { id: string; code: string; projects: string[]; members: Record<string, Membership>;
  invitations: Record<string, { from: string; project: string; reason: string }>;
  temporaryTurns?: Map<string, string> };
type Data = { version: 1; rooms: Room[] };
const temporaryIdsFile = 'temporary-room-ids.json';
const retainedTemporaryIds = 256;

async function persist(path: string, value: unknown) {
  const scratch = `${path}.${randomUUID()}.tmp`;
  await writeFile(scratch, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  try { await rename(scratch, path); }
  catch (error) { await unlink(scratch).catch(() => {}); throw error; }
}

/** RoomStore owns message ordering/dedup/wait; this file holds host-bound memberships, never model-supplied tokens. */
export class CollaborationState {
  private tail: Promise<unknown> = Promise.resolve();
  private transientRooms: Room[] = [];
  readonly temporaryStore = RoomStore.inMemory();
  private constructor(readonly store: RoomStore, readonly directory: string, private data: Data,
    private issuedTemporaryIds: Set<string>) {}
  static async open(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let data: Data = { version: 1, rooms: [] };
    try {
      data = JSON.parse(await readFile(join(directory, 'memberships.json'), 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.rooms)) throw new Error('Invalid AgentChatroom membership state.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let ids: string[] = [];
    try {
      ids = JSON.parse(await readFile(join(directory, temporaryIdsFile), 'utf8'));
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Invalid temporary room ID state.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return new CollaborationState(await RoomStore.open(join(directory, 'rooms')), directory, data, new Set(ids));
  }
  get rooms() { return this.data.rooms; }
  get temporaryRooms() { return this.transientRooms; }
  hasIssuedTemporaryId(id: string) { return this.issuedTemporaryIds.has(id); }
  /** Only issued IDs are durable. Any ID with no active room has ended, including after restart. */
  async rememberTemporaryId(id: string) {
    const prior = [...this.issuedTemporaryIds];
    const active = new Set(this.transientRooms.map(room => room.id));
    const stillRetained = new Set(prior.slice(1 - retainedTemporaryIds));
    const ids = [...prior.filter(id => active.has(id) || stillRetained.has(id)), id];
    await persist(join(this.directory, temporaryIdsFile), ids);
    this.issuedTemporaryIds = new Set(ids);
  }
  transaction<T>(operation: (rooms: Room[], temporary: boolean) => Promise<T>, chooseTemporary: boolean | (() => boolean) = false): Promise<T> {
    const run = this.tail.then(async () => {
      const temporary = typeof chooseTemporary === 'function' ? chooseTemporary() : chooseTemporary;
      const rooms = structuredClone(temporary ? this.transientRooms : this.data.rooms);
      const result = await operation(rooms, temporary);
      if (temporary) {
        this.transientRooms = rooms;
        return result;
      }
      const draft = { ...this.data, rooms };
      await persist(join(this.directory, 'memberships.json'), draft);
      this.data = draft;
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
  async close() { await this.tail; await this.temporaryStore.close(); await this.store.close(); }
}

// Bundle generations share one writer while old in-flight calls settle. The last release closes it;
// an immediately arriving replacement waits for close before reopening the same durable journal.
type Lease = { ready: Promise<CollaborationState>; refs: number; closing?: Promise<void> };
const symbol = Symbol.for('cardbush.agentchatroom.writer.v1');
const shared = globalThis as typeof globalThis & { [symbol]?: Map<string, Lease> };
const leases: Map<string, Lease> = shared[symbol] ??= new Map<string, Lease>();
export function acquireState(directory: string): { ready: Promise<CollaborationState>; release: () => Promise<void> | undefined } {
  const key = resolve(directory);
  let lease = leases.get(key);
  if (!lease || lease.closing) {
    const closing = lease?.closing;
    lease = { refs: 0, ready: Promise.resolve(closing).then(() => CollaborationState.open(key)) };
    // Report initialization errors to the first context/tool caller, never as an unhandled rejection.
    void lease.ready.catch(() => {});
    leases.set(key, lease);
  }
  lease.refs++;
  const current = lease;
  let released = false;
  return { ready: current.ready, release: () => {
    if (released) return current.closing;
    released = true;
    if (--current.refs) return;
    current.closing = current.ready.then(state => state.close(), () => {});
    void current.closing.finally(() => { if (leases.get(key) === current) leases.delete(key); }).catch(() => {});
    return current.closing;
  } };
}
