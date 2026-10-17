import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { schemas, humanJoinSchema, type Input, type ToolName } from './schema.js';

export class ChatError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export const secret = () => randomBytes(24).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Member = { participant_id: string; name: string; kind: 'agent' | 'human'; token_hash: string;
  invited_by_agent_id?: string; joined_at: string; active: boolean };
type Invite = { invite_id: string; code_hash: string; agent_id: string; expires_at: number; consumed: boolean };
type Room = { room_id: string; name: string; description: string; visibility: 'listed' | 'unlisted';
  code_hash: string; owner_id: string; created_at: string; closed: boolean; members: Member[]; invites: Invite[] };
export type Message = { seq: number; message_id: string; participant_id: string; kind: Member['kind'];
  name: string; invited_by_agent_id?: string; text: string; timestamp: string; client_message_id: string; reply_to?: number; mentions?: string[] };
type Event = { type: 'room'; room: Room } | { type: 'message'; room_id: string; message: Message };
const publicMember = ({ token_hash: _token, ...member }: Member) => member;
const publicRoom = (room: Room) => ({ room_id: room.room_id, name: room.name, description: room.description,
  visibility: room.visibility, owner_id: room.owner_id, created_at: room.created_at, closed: room.closed });
const timestamp = () => new Date().toISOString();
function fail(code: string, message: string, status = 400): never { throw new ChatError(code, message, status); }

/** A single writer durably appends events before exposing them or waking readers. */
export class RoomStore {
  private rooms = new Map<string, Room>();
  private messages = new Map<string, Message[]>();
  private dedup = new Map<string, Message>();
  private watchers = new Map<string, Set<() => void>>();
  private activity = new Map<string, { last_seen_at: string; waiting: number }>();
  private writes: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private broken = false;
  private closing?: Promise<void>;
  private constructor(private journal: FileHandle, private lockPath: string) {}

  static async open(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = join(directory, 'writer.lock');
    for (let attempt = 0; ; attempt++) {
      try {
        const lock = await open(lockPath, 'wx', 0o600);
        await lock.writeFile(JSON.stringify({ pid: process.pid }));
        await lock.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 1) throw error;
        const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
        if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('Invalid writer.lock; inspect it before recovery.');
        try { process.kill(lock.pid, 0); throw new ChatError('service_running', 'A service already owns this data directory.', 409); }
        catch (running) { if ((running as NodeJS.ErrnoException).code !== 'ESRCH') throw running; }
        await unlink(lockPath);
      }
    }
    let journal: FileHandle | undefined;
    try {
      journal = await open(join(directory, 'events.jsonl'), 'a+', 0o600);
      const store = new RoomStore(journal, lockPath);
      const bytes = await journal.readFile();
      const end = bytes.lastIndexOf(10) + 1;
      // A crash can leave an incomplete final record. Never skip corruption in a committed line.
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
        if (line) store.apply(JSON.parse(line) as Event);
      }
      if (end !== bytes.length) {
        // Windows append handles cannot be truncated; use a separate writable handle for recovery.
        await journal.close();
        journal = await open(join(directory, 'events.jsonl'), 'r+');
        await journal.truncate(end); await journal.sync(); await journal.close();
        journal = await open(join(directory, 'events.jsonl'), 'a+', 0o600);
        store.journal = journal;
      }
      return store;
    } catch (error) { await journal?.close(); await unlink(lockPath); throw error; }
  }

  private apply(event: Event) {
    if (event.type === 'room') {
      this.rooms.set(event.room.room_id, event.room);
      if (!this.messages.has(event.room.room_id)) this.messages.set(event.room.room_id, []);
    } else if (event.type === 'message') {
      const messages = this.messages.get(event.room_id);
      if (!messages || event.message.seq !== messages.length + 1) throw new Error('Corrupt message sequence in journal.');
      messages.push(event.message);
      this.dedup.set(this.messageKey(event.room_id, event.message.participant_id, event.message.client_message_id), event.message);
    } else throw new Error('Unknown journal event.');
  }

  private messageKey(room: string, member: string, id: string) { return JSON.stringify([room, member, id]); }
  private async commit(event: Event) {
    try { await this.journal.appendFile(`${JSON.stringify(event)}\n`); await this.journal.datasync(); }
    catch (error) { this.broken = true; this.wakeAll(); throw error; }
    this.apply(event);
    const id = event.type === 'room' ? event.room.room_id : event.room_id;
    for (const notify of this.watchers.get(id) ?? []) notify();
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(() => {
      if (this.stopped || this.broken) fail('service_unavailable', 'The room service is stopping or storage is unavailable.', 503);
      return operation();
    });
    this.writes = result.catch(() => undefined);
    return result;
  }

  private room(id: string) { return this.rooms.get(id) ?? fail('not_found', 'Room not found.', 404); }
  private member(room: Room, token: string, allowInactive = false) {
    const member = room.members.find(value => value.token_hash === hash(token));
    if (!member) fail('unauthorized', 'Invalid room membership.', 403);
    if (!allowInactive && !member.active) fail('membership_revoked', 'This participant has left or was removed.', 403);
    this.touch(member);
    return member;
  }
  private touch(member: Member) {
    const state = this.activity.get(member.participant_id) ?? { last_seen_at: timestamp(), waiting: 0 };
    state.last_seen_at = timestamp(); this.activity.set(member.participant_id, state);
    return state;
  }
  private participant(room: Room, member: Member) {
    const state = this.activity.get(member.participant_id);
    const listening = member.active && !room.closed && !this.stopped && !this.broken && (state?.waiting ?? 0) > 0;
    return { ...publicMember(member), membership_status: member.active ? 'joined' : 'left',
      presence: !member.active ? 'left' : room.closed ? 'room_closed' : listening ? 'listening' : 'not_listening',
      pending_waits: listening ? state!.waiting : 0, last_seen_at: state?.last_seen_at ?? null };
  }
  private cursor(room: Room, member: Member, seq: number) {
    const payload = Buffer.from(JSON.stringify([room.room_id, member.participant_id, seq])).toString('base64url');
    return `${payload}.${createHmac('sha256', member.token_hash).update(payload).digest('base64url')}`;
  }
  private position(room: Room, member: Member, args: { after_seq?: number; read_cursor?: string }, required = false) {
    if (!args.read_cursor) {
      if (required && args.after_seq === undefined) fail('invalid_cursor', 'Provide read_cursor from check/join, or a last-read after_seq.');
      return args.after_seq ?? 0;
    }
    try {
      const [payload, signature, extra] = args.read_cursor.split('.');
      const expected = createHmac('sha256', member.token_hash).update(payload!).digest();
      const supplied = Buffer.from(signature!, 'base64url');
      if (extra || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
      const [roomId, participantId, seq] = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
      if (roomId !== room.room_id || participantId !== member.participant_id || !Number.isSafeInteger(seq) || seq < 0 ||
        (args.after_seq !== undefined && args.after_seq !== seq)) throw new Error();
      return seq as number;
    } catch { return fail('invalid_cursor', 'Use an unchanged read_cursor from this membership; do not combine it with a different after_seq.'); }
  }
  private active(room: Room) { if (room.closed) fail('room_closed', 'The room is closed.', 409); }
  private newMember(name: string, kind: Member['kind'], invitedBy?: string) {
    const token = secret();
    const member: Member = { participant_id: randomUUID(), name, kind, token_hash: hash(token),
      ...(invitedBy ? { invited_by_agent_id: invitedBy } : {}), joined_at: timestamp(), active: true };
    return { member, token };
  }
  private joined(room: Room, member: Member, token: string) {
    this.touch(member);
    return { room: publicRoom(room), participant: this.participant(room, member), member_token: token,
      latest_seq: this.messages.get(room.room_id)!.length, read_after_seq: 0, read_cursor: this.cursor(room, member, 0) };
  }

  async execute(name: ToolName, input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const value = schemas[name].parse(input);
    if (this.stopped || this.broken) fail('service_unavailable', 'The room service is unavailable.', 503);
    switch (name) {
      case 'chatroom_create': return this.create(value as Input<'chatroom_create'>);
      case 'chatroom_list': return this.list(value as Input<'chatroom_list'>);
      case 'chatroom_join': return this.join(value as Input<'chatroom_join'>);
      case 'chatroom_members': {
        const args = value as Input<'chatroom_members'>, room = this.room(args.room_id);
        this.member(room, args.member_token);
        return { room: publicRoom(room), participants: room.members.map(member => this.participant(room, member)) };
      }
      case 'chatroom_send': return this.send(value as Input<'chatroom_send'>);
      case 'chatroom_check': return this.check(value as Input<'chatroom_check'>);
      case 'chatroom_await': return this.wait(value as Input<'chatroom_await'>, signal);
      case 'chatroom_manage': return this.manage(value as Input<'chatroom_manage'>);
      case 'chatroom_leave': return this.leave(value as Input<'chatroom_leave'>);
      case 'chatroom_human_invite': return this.invite(value as Input<'chatroom_human_invite'>);
      case 'chatroom_revoke_invite': return this.revoke(value as Input<'chatroom_revoke_invite'>);
    }
  }

  private create(args: Input<'chatroom_create'>) {
    return this.mutate(async () => {
      if (this.rooms.size >= 1000) fail('capacity', 'Server room capacity reached.', 429);
      const { member, token } = this.newMember(args.agent_name, 'agent'), code = secret();
      const room: Room = { room_id: randomUUID(), name: args.name, description: args.description,
        visibility: args.visibility, code_hash: hash(code), owner_id: member.participant_id,
        created_at: timestamp(), closed: false, members: [member], invites: [] };
      await this.commit({ type: 'room', room });
      return { ...this.joined(room, member, token), code };
    });
  }

  private list(args: Input<'chatroom_list'>) {
    const rooms = [...this.rooms.values()].filter(room => !room.closed && room.visibility === 'listed');
    return { rooms: rooms.slice(args.offset, args.offset + args.limit).map(publicRoom),
      has_more: rooms.length > args.offset + args.limit, next_offset: Math.min(rooms.length, args.offset + args.limit) };
  }

  private join(args: Input<'chatroom_join'>) {
    return this.mutate(async () => {
      const found = [...this.rooms.values()].find(room => !room.closed && room.code_hash === hash(args.code));
      if (!found) fail('invalid_code', 'Invalid or expired room code.', 403);
      const room = structuredClone(found);
      if (room.members.length >= 2000) fail('capacity', 'Room participant capacity reached.', 429);
      const { member, token } = this.newMember(args.agent_name, 'agent');
      room.members.push(member);
      await this.commit({ type: 'room', room });
      return this.joined(room, member, token);
    });
  }

  private send(args: Input<'chatroom_send'>) {
    return this.mutate(async () => {
      const room = this.room(args.room_id), member = this.member(room, args.member_token);
      this.active(room);
      const previous = this.dedup.get(this.messageKey(room.room_id, member.participant_id, args.client_message_id));
      const mentions = [...new Set(args.mentions ?? [])].sort();
      if (mentions.some(id => !room.members.some(member => member.participant_id === id))) fail('invalid_mention', 'Mentioned participant is not a member of this room.');
      if (previous) {
        if (previous.text !== args.text || previous.reply_to !== args.reply_to || JSON.stringify(previous.mentions ?? []) !== JSON.stringify(mentions)) fail('id_conflict', 'client_message_id was already used for different content.', 409);
        return { message: previous, duplicate: true, read_cursor_advanced: false };
      }
      const messages = this.messages.get(room.room_id)!;
      if (messages.length >= 100000) fail('capacity', 'Room message capacity reached; create another room.', 429);
      if (args.reply_to !== undefined && (args.reply_to < 1 || args.reply_to > messages.length)) fail('invalid_reply', 'reply_to must name an existing message sequence.');
      const { token_hash: _token, active: _active, joined_at: _joined, ...identity } = member;
      const message: Message = { ...identity, seq: messages.length + 1, message_id: randomUUID(),
        text: args.text, timestamp: timestamp(), client_message_id: args.client_message_id,
        ...(args.reply_to === undefined ? {} : { reply_to: args.reply_to }), ...(mentions.length ? { mentions } : {}) };
      await this.commit({ type: 'message', room_id: room.room_id, message });
      return { message, duplicate: false, read_cursor_advanced: false };
    });
  }

  private check(args: Input<'chatroom_check'>) {
    const room = this.room(args.room_id), member = this.member(room, args.member_token);
    const after = this.position(room, member, args);
    const messages = this.messages.get(room.room_id)!;
    if (after > messages.length) fail('invalid_cursor', 'after_seq is ahead of this room.');
    const page = messages.slice(after, after + args.limit);
    const next = page.at(-1)?.seq ?? after;
    return { room: publicRoom(room), messages: page, next_seq: next, read_cursor: this.cursor(room, member, next), latest_seq: messages.length, has_more: next < messages.length };
  }

  private wait(args: Input<'chatroom_await'>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const initialRoom = this.room(args.room_id), caller = this.member(initialRoom, args.member_token);
    const after = this.position(initialRoom, caller, args, true);
    const participants = args.participants ? [...new Set(args.participants)] : undefined;
    if (args.mode === 'all' && !participants) fail('invalid_filter', 'mode=all requires participants.');
    if (!args.include_self && participants?.includes(caller.participant_id)) fail('invalid_filter', 'Self is excluded; set include_self to wait for yourself.');
    for (const id of participants ?? []) if (!initialRoom.members.some(member => member.participant_id === id)) fail('invalid_filter', 'Unknown participant in this room.');
    if (after > this.messages.get(args.room_id)!.length) fail('invalid_cursor', 'after_seq is ahead of this room.');
    if (args.reply_to !== undefined && (args.reply_to < 1 || args.reply_to > this.messages.get(args.room_id)!.length)) fail('invalid_reply', 'reply_to must name an existing message.');
    let listeners = this.watchers.get(args.room_id);
    if (!listeners) this.watchers.set(args.room_id, listeners = new Set());
    if (listeners.size >= 128 || this.pendingWaits >= 2048) fail('capacity', 'Too many pending waits.', 429);
    const activity = this.touch(caller); activity.waiting++;
    return new Promise(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let scannedThrough = after;
      const matched = new Set<string>();
      const matchedSeqs: number[] = [];
      // Check and subscribe without yielding: a committed message cannot fall between them.
      const finish = (status: string, extra: Record<string, unknown> = {}) => {
        if (settled) return;
        settled = true; clearTimeout(timer); listeners!.delete(wake);
        activity.waiting--; activity.last_seen_at = timestamp();
        if (!listeners!.size) this.watchers.delete(args.room_id);
        signal?.removeEventListener('abort', cancel);
        resolve({ status, read_after_seq: after, read_cursor: this.cursor(initialRoom, caller, after), latest_seq: this.messages.get(args.room_id)!.length, ...extra });
      };
      const wake = () => {
        const room = this.room(args.room_id);
        if (this.stopped || this.broken) return finish('service_stopped');
        if (!room.members.find(member => member.participant_id === caller.participant_id)?.active) return finish('membership_revoked');
        if (room.closed) return finish('room_closed');
        const messages = this.messages.get(args.room_id)!;
        for (; scannedThrough < messages.length;) {
          const message = messages[scannedThrough++];
          if ((!args.include_self && message.participant_id === caller.participant_id)
            || (participants && !participants.includes(message.participant_id))
            || (args.mentioned_only && !message.mentions?.includes(caller.participant_id))
            || (args.reply_to !== undefined && message.reply_to !== args.reply_to)) continue;
          if (!matched.has(message.participant_id)) matchedSeqs.push(message.seq);
          matched.add(message.participant_id);
          if (args.mode === 'any' || matched.size === participants!.length) return finish('messages', { matched_participants: [...matched], matched_seqs: matchedSeqs });
        }
        const departed = participants?.filter(id => !room.members.find(member => member.participant_id === id)?.active && !matched.has(id)) ?? [];
        if (departed.length && (args.mode === 'all' || departed.length === participants!.length)) finish('participant_left', { participants: departed });
      };
      const cancel = () => finish('cancelled');
      listeners!.add(wake);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel(); else wake();
      if (!settled) timer = setTimeout(() => finish('timeout'), args.timeout_ms);
    });
  }

  private manage(args: Input<'chatroom_manage'>) {
    return this.mutate(async () => {
      const room = structuredClone(this.room(args.room_id)), member = this.member(room, args.member_token);
      if (member.participant_id !== room.owner_id) fail('owner_required', 'Only this room’s owner can manage it.', 403);
      this.active(room);
      let code: string | undefined;
      if (args.action === 'update') {
        if (args.name !== undefined) room.name = args.name;
        if (args.description !== undefined) room.description = args.description;
        if (args.visibility !== undefined) room.visibility = args.visibility;
      } else if (args.action === 'rotate_code') { code = secret(); room.code_hash = hash(code); }
      else if (args.action === 'close') { room.closed = true; room.invites = []; }
      else {
        const target = room.members.find(value => value.participant_id === args.participant_id);
        if (!target) fail('not_found', 'Participant not found.', 404);
        if (target.participant_id === room.owner_id) fail('owner_required', 'The owner must close the room instead of leaving.');
        target.active = false;
        room.invites = room.invites.filter(invite => invite.agent_id !== target.participant_id);
      }
      await this.commit({ type: 'room', room });
      return { room: publicRoom(room), ...(code ? { code } : {}) };
    });
  }

  private leave(args: Input<'chatroom_leave'>) {
    return this.mutate(async () => {
      const room = structuredClone(this.room(args.room_id)), member = this.member(room, args.member_token, true);
      if (member.participant_id === room.owner_id) fail('owner_required', 'The owner must close the room instead of leaving.');
      member.active = false;
      room.invites = room.invites.filter(invite => invite.agent_id !== member.participant_id);
      await this.commit({ type: 'room', room });
      return { status: 'left', participant_id: member.participant_id };
    });
  }

  private invite(args: Input<'chatroom_human_invite'>) {
    return this.mutate(async () => {
      const room = structuredClone(this.room(args.room_id)), member = this.member(room, args.member_token);
      this.active(room);
      if (member.kind !== 'agent') fail('agent_required', 'Human invitations must originate from an agent membership.', 403);
      room.invites = room.invites.filter(invite => !invite.consumed && invite.expires_at > Date.now());
      if (room.invites.length >= 1000) fail('capacity', 'Too many outstanding invitations.', 429);
      const code = secret(), invite: Invite = { invite_id: randomUUID(), code_hash: hash(code),
        agent_id: member.participant_id, expires_at: Date.now() + args.expires_in_seconds * 1000, consumed: false };
      room.invites.push(invite);
      await this.commit({ type: 'room', room });
      return { invite_id: invite.invite_id, humen_code: code, expires_at: new Date(invite.expires_at).toISOString(),
        invited_by_agent_id: member.participant_id };
    });
  }

  redeemHuman(input: unknown) {
    const args = humanJoinSchema.parse(input);
    return this.mutate(async () => {
      const code = hash(args.humen_code);
      const found = [...this.rooms.values()].find(room => !room.closed && room.invites.some(invite => invite.code_hash === code));
      if (!found) fail('invalid_invite', 'Invalid, expired or redeemed human invitation.', 403);
      const room = structuredClone(found), invite = room.invites.find(value => value.code_hash === code)!;
      if (invite.consumed || invite.expires_at <= Date.now() || !room.members.some(member => member.participant_id === invite.agent_id && member.active)) fail('invalid_invite', 'Invalid, expired or redeemed human invitation.', 403);
      if (room.members.length >= 2000) fail('capacity', 'Room participant capacity reached.', 429);
      const { member, token } = this.newMember(args.name, 'human', invite.agent_id);
      invite.consumed = true; room.members.push(member);
      await this.commit({ type: 'room', room });
      return this.joined(room, member, token);
    });
  }

  private revoke(args: Input<'chatroom_revoke_invite'>) {
    return this.mutate(async () => {
      const room = structuredClone(this.room(args.room_id)), member = this.member(room, args.member_token);
      const invite = room.invites.find(value => value.invite_id === args.invite_id);
      if (!invite) fail('not_found', 'Invitation not found.', 404);
      if (invite.agent_id !== member.participant_id && room.owner_id !== member.participant_id) fail('forbidden', 'Only the issuer or room owner can revoke this invitation.', 403);
      room.invites = room.invites.filter(value => value !== invite);
      await this.commit({ type: 'room', room });
      return { status: 'revoked', invite_id: args.invite_id };
    });
  }

  get pendingWaits() { return [...this.watchers.values()].reduce((count, listeners) => count + listeners.size, 0); }
  private wakeAll() { for (const listeners of this.watchers.values()) for (const wake of listeners) wake(); }
  close() {
    return this.closing ??= (async () => {
      this.stopped = true; this.wakeAll(); await this.writes;
      await this.journal.close(); await unlink(this.lockPath);
    })();
  }
}
