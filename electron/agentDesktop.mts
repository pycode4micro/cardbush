import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentDesktopFrame, AgentDesktopStatus } from './agentDesktopTypes.js';
import { browserActionSchema, computerActionSchema, desktopInputSchema, desktopToolRequestSchema } from './agentDesktopSchema.mjs';
import { AgentDesktopWorker, type DesktopWorker } from './agentDesktopWorker.mjs';
import { checkedExternalWebUrl } from './externalWebUrl.js';

const tokenSchema = z.string().uuid();
const frameSchema = z.object({ width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(2160),
  data: z.string().min(1).max(6 * 1024 * 1024), mimeType: z.literal('image/jpeg') });
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const leaseDuration = 20_000;

/** One shared desktop per Personal Agent. Both tools and manual input use this arbiter. */
export class AgentDesktop {
  #queue: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #closed = false;
  #error?: string;
  #lease?: { token: string; until: number };
  #frames = new Map<string, { at: number; width: number; height: number; token: string }>();
  #observed?: { id: string; at: number; scope: string; tool: string; tabId?: string };
  constructor(readonly worker: DesktopWorker, readonly now = Date.now) {}

  static async open(root: string, env: NodeJS.ProcessEnv) {
    if (process.platform !== 'linux') throw new Error('--desktop requires the optional Linux Personal Agent image.');
    const profile = join(root, 'desktop', 'browser');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const desktop = new AgentDesktop(new AgentDesktopWorker(profile, env));
    try { await desktop.worker.request('initialize'); return desktop; }
    catch (error) { await desktop.close(); throw error; }
  }
  #expire() { if (this.#lease && this.#lease.until <= this.now()) { this.#lease = undefined; this.#invalidate(); } }
  #invalidate() { this.#observed = undefined; this.#frames.clear(); }
  status(): AgentDesktopStatus {
    this.#expire();
    if (this.worker.failure) { this.#error = this.worker.failure; this.#invalidate(); }
    return { available: !this.#closed && !this.#error, control: this.#lease ? 'user' : 'agent', leaseExpiresAt: this.#lease?.until ?? null,
      ...(this.#error ? { error: this.#error } : {}) };
  }
  #exclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#queued >= 12) return Promise.reject(new Error('Desktop is busy. Wait for the current operation.'));
    this.#queued++;
    const task = this.#queue.then(async () => {
      signal?.throwIfAborted();
      if (!this.status().available) throw new Error(this.#error || 'Desktop is closed.');
      return work();
    });
    this.#queue = task.catch(() => undefined);
    return task.finally(() => { this.#queued--; });
  }
  async #request(operation: string, input?: unknown) {
    try { return await this.worker.request(operation, input); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/outcome unknown|worker exited|protocol|connection was interrupted/i.test(message)) { this.#error = message; this.#invalidate(); }
      throw error;
    }
  }
  #requireLease(token: unknown) {
    const value = tokenSchema.parse(token); this.#expire();
    if (!this.#lease || !equal(this.#lease.token, value)) throw new Error('Desktop control expired or belongs to another viewer. Take control again.');
    return this.#lease;
  }
  async call(action: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (action === 'status') return this.status();
    if (action === 'take') {
      this.#expire();
      if (this.#lease) throw new Error('Another viewer already controls this desktop.');
      // Block queued Agent actions immediately, then wait for an already dispatched action.
      const lease = { token: randomUUID(), until: this.now() + leaseDuration };
      this.#lease = lease; this.#invalidate();
      try { return await this.#exclusive(async () => {
        if (this.#lease !== lease) throw new Error('Control request expired.');
        lease.until = this.now() + leaseDuration;
        return { ...this.status(), token: lease.token };
      }, signal); } catch (error) { if (this.#lease === lease) this.#lease = undefined; throw error; }
    }
    if (action === 'release') {
      this.#requireLease(input.token); this.#lease = undefined; this.#invalidate();
      return this.status();
    }
    return this.#exclusive(async () => {
      if (action === 'frame') {
        const lease = input.token ? this.#requireLease(input.token) : undefined;
        if (lease) lease.until = this.now() + leaseDuration;
        const image = frameSchema.parse(await this.#request('frame'));
        const frameId = randomUUID();
        if (lease) {
          this.#frames.set(frameId, { at: this.now(), width: image.width, height: image.height, token: lease.token });
          while (this.#frames.size > 8) this.#frames.delete(this.#frames.keys().next().value!);
        }
        return { ...this.status(), ...image, frameId, capturedAt: this.now() } satisfies AgentDesktopFrame;
      }
      if (action === 'input') {
        const lease = this.#requireLease(input.token);
        const frame = this.#frames.get(tokenSchema.parse(input.frameId));
        if (!frame || frame.token !== lease.token || this.now() - frame.at > 5000) throw new Error('Desktop frame is stale. Wait for a fresh frame.');
        const event = desktopInputSchema.parse(input.event);
        if ('x' in event && (event.x >= frame.width || event.y >= frame.height || ('toX' in event && (event.toX >= frame.width || event.toY >= frame.height)))) throw new Error('Pointer is outside the desktop.');
        lease.until = this.now() + leaseDuration; this.#observed = undefined;
        await this.#request('input', { ...event, width: frame.width, height: frame.height });
        return this.status();
      }
      throw new Error('Unknown desktop operation.');
    }, signal);
  }
  async tool(raw: unknown, signal?: AbortSignal) {
    const request = desktopToolRequestSchema.parse(raw);
    const input = request.tool === 'computer' ? computerActionSchema.parse(request.input) : browserActionSchema.parse(request.input);
    const scope = JSON.stringify([request.sessionId, request.turnId]);
    const read = ['observe', 'tabs', 'snapshot', 'screenshot'].includes(input.action);
    return this.#exclusive(async () => {
      if (this.#lease) throw new Error('The user has taken control. Do not retry or bypass with terminal/CDP. Wait for the user to return control.');
      if (!read && input.action !== 'open') {
        const state = this.#observed;
        if (!state || state.scope !== scope || state.tool !== request.tool || state.id !== input.stateId || this.now() - state.at > 15_000 ||
          ('tabId' in input && input.tabId !== state.tabId)) throw new Error('Missing or stale observation. Observe this desktop/tab again before acting.');
      }
      this.#invalidate();
      if (request.tool === 'computer' && input.action !== 'observe') {
        const { stateId: _state, ...event } = input;
        desktopInputSchema.parse(event);
      }
      if ('url' in input && (input.action === 'open' || input.action === 'navigate')) input.url = checkedExternalWebUrl(input.url);
      const result = await this.#request(request.tool, input);
      const stateId = randomUUID();
      if (read && input.action !== 'tabs') this.#observed = { id: stateId, at: this.now(), scope, tool: request.tool,
        ...('tabId' in input ? { tabId: input.tabId } : {}) };
      const { image, ...data } = result;
      const structuredContent = { ...data, ...(this.#observed ? { stateId } : {}) };
      return { structuredContent, content: [
        { type: 'text', text: JSON.stringify(structuredContent) },
        ...(image ? [{ type: 'image', ...frameSchema.parse(image), _meta: { 'codex/imageDetail': 'original' } }] : []),
      ] };
    }, signal);
  }
  async close() { this.#closed = true; this.#lease = undefined; this.#invalidate(); await this.#queue; await this.worker.close(); }
}
