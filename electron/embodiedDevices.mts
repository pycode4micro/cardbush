import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writePrivateJson } from './atomicJsonFile.mjs';

export const deviceIdSchema = z.string().regex(/^[a-zA-Z0-9:_-]{6,100}$/);
export const deviceListenerSchema = z.object({
  enabled: z.boolean().default(false), host: z.enum(['127.0.0.1', '0.0.0.0']).default('0.0.0.0'),
  port: z.number().int().min(0).max(65535).default(4782),
  publicUrl: z.string().max(2048).default(''),
  tlsCert: z.string().max(2048).default(''), tlsKey: z.string().max(2048).default(''),
}).strict();
const deviceSchema = z.object({ id: deviceIdSchema, name: z.string().trim().min(1).max(100), board: z.string().min(1).max(100),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string(), revoked: z.boolean().default(false) }).strict();
const savedSchema = z.object({ version: z.literal(1), listener: deviceListenerSchema, devices: z.array(deviceSchema).max(128) });
export type PairedDevice = z.infer<typeof deviceSchema>;
export function hashDeviceToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
export function deviceEndpoint(value: string) {
  const url = new URL(value);
  const host = url.hostname;
  const privateHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || /^10\.\d+\.\d+\.\d+$/.test(host) || /^192\.168\.\d+\.\d+$/.test(host) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && privateHost) || url.username || url.password || url.search || url.hash || url.pathname !== '/api/embodied/v1/audio') throw Error('Use wss://HOST/api/embodied/v1/audio; ws:// is limited to a private LAN IP.');
  return url.href;
}
/** Persist only hashes. Device credentials never authorize host management or tools. */
export class EmbodiedDeviceStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}
  async read() {
    return readFile(this.file, 'utf8').then(text => savedSchema.parse(JSON.parse(text)), (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return savedSchema.parse({ version: 1, listener: {}, devices: [] });
    });
  }
  private change<T>(run: (state: z.infer<typeof savedSchema>) => T): Promise<T> {
    const next = this.tail.then(async () => {
      const state = await this.read(), result = run(state);
      savedSchema.parse(state);
      await writePrivateJson(this.file, state);
      return result;
    }); this.tail = next.catch(() => {}); return next;
  }
  configure(input: unknown) { const listener = deviceListenerSchema.parse(input); if (listener.publicUrl) listener.publicUrl = deviceEndpoint(listener.publicUrl);
    if (Boolean(listener.tlsCert) !== Boolean(listener.tlsKey)) throw Error('Both TLS certificate and key are required.');
    return this.change(state => { state.listener = listener; return listener; }); }
  pair(input: unknown) {
    const value = z.object({ id: deviceIdSchema, name: z.string().trim().min(1).max(100), board: z.string().min(1).max(100) }).strict().parse(input);
    return this.change(state => {
      if (state.devices.some(device => device.id === value.id && !device.revoked)) throw Error('Device is already paired. Revoke it explicitly before provisioning again.');
      const token = randomBytes(32).toString('hex');
      state.devices = state.devices.filter(device => device.id !== value.id);
      state.devices.push({ ...value, tokenHash: hashDeviceToken(token), createdAt: new Date().toISOString(), revoked: false });
      return { ...value, token };
    });
  }
  revoke(id: string) { deviceIdSchema.parse(id); return this.change(state => { const found = state.devices.find(device => device.id === id); if (!found) throw Error('Unknown device.'); found.revoked = true; return { id, revoked: true }; }); }
  async authenticate(id: string, token: string): Promise<PairedDevice | undefined> {
    if (!deviceIdSchema.safeParse(id).success || !/^[a-f0-9]{64}$/.test(token)) return;
    const device = (await this.read()).devices.find(item => item.id === id && !item.revoked);
    if (device && timingSafeEqual(Buffer.from(device.tokenHash, 'hex'), Buffer.from(hashDeviceToken(token), 'hex'))) return device;
  }
  async list() { return (await this.read()).devices.map(({ tokenHash: _hash, ...device }) => device); }
}
