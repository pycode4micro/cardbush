import { createServer } from 'node:http';
import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { EmbodiedGateway } from './embodiedGateway.mjs';
import { EmbodiedDeviceStore } from './embodiedDevices.mjs';
import { AssistantDeviceCall, AssistantHostSettingsStore, createAssistantVoiceExecutor, type AssistantVoiceRuntime } from './assistantVoiceHost.mjs';
import { RealtimeVoiceService, connectRealtimeVoice } from './realtimeVoiceService.js';
import { writePrivateJson } from './atomicJsonFile.mjs';

export class EmbodiedHost {
  readonly devices: EmbodiedDeviceStore;
  readonly assistant: AssistantHostSettingsStore;
  readonly gateway: EmbodiedGateway;
  private management?: ReturnType<typeof createServer>;
  private operations: Promise<unknown> = Promise.resolve();
  private descriptor?: string;
  constructor(readonly root: string, readonly voice: RealtimeVoiceService, runtime: AssistantVoiceRuntime,
    options: { voicePreference?(): 'female' | 'male' } = {}) {
    this.devices = new EmbodiedDeviceStore(join(root, 'embodied', 'devices.json'));
    this.assistant = new AssistantHostSettingsStore(join(root, 'embodied', 'assistant.json'));
    this.gateway = new EmbodiedGateway(this.devices, async (device, emit) => {
      const settings = await this.assistant.read();
      if (options.voicePreference) settings.voice = options.voicePreference();
      if (settings.profile.outputMuted) throw Error('Assistant speech is muted on the host.');
      const executor = await createAssistantVoiceExecutor(runtime, settings);
      return new AssistantDeviceCall(voice, `device:${device.id}`, settings, executor, emit);
    });
  }
  async start(localControl = false) {
    // A stale bind/configuration must not prevent the desktop or Agent from starting.
    await this.gateway.start().catch(error => { console.warn('[embodied] listener failed:', error instanceof Error ? error.message : 'unknown'); });
    if (!localControl) return;
    const token = randomBytes(32).toString('hex');
    const server = createServer((request, response) => {
      const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(request.headers.authorization || '');
      if (request.headers.origin || supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) { response.writeHead(401).end(); return; }
      if (request.method !== 'POST' || request.url !== '/command' || request.headers['content-type'] !== 'application/json') { response.writeHead(404).end(); return; }
      void (async () => {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { size += chunk.length; if (size > 16384) throw Error('Command too large.'); chunks.push(Buffer.from(chunk)); }
        const result = await this.command(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ result }));
      })().catch(error => { if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Device command failed.' })); });
    });
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    this.management = server;
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Invalid control endpoint.');
    this.descriptor = join(this.root, 'embodied', 'control.json');
    await writePrivateJson(this.descriptor, { url: `http://127.0.0.1:${address.port}/command`, token, pid: process.pid });
  }
  command(input: unknown): Promise<unknown> {
    const next = this.operations.then(() => this.execute(input)); this.operations = next.catch(() => {}); return next;
  }
  private async execute(input: unknown) {
    const request = z.object({ action: z.enum(['status', 'configure', 'pair', 'revoke', 'assistant.get', 'assistant.save', 'voice.get', 'voice.save']), input: z.unknown().optional() }).strict().parse(input);
    switch (request.action) {
      case 'status': return { protocol: 'cardbush.embodied.v1', ...this.gateway.snapshot(), listener: (await this.devices.read()).listener,
        paired: await this.devices.list(), voice: this.voice.settings(), assistant: await this.assistant.read() };
      case 'assistant.get': return this.assistant.read();
      case 'assistant.save': return this.assistant.save(request.input);
      case 'voice.get': return this.voice.settings();
      case 'voice.save': return this.voice.save(request.input as Parameters<RealtimeVoiceService['save']>[0]);
      case 'pair': return this.devices.pair(request.input);
      case 'revoke': { const { id } = z.object({ id: z.string() }).strict().parse(request.input); const result = await this.devices.revoke(id); this.gateway.disconnect(id); return result; }
      case 'configure': {
        const previous = (await this.devices.read()).listener;
        await this.devices.configure(request.input);
        await this.gateway.close();
        try { return await this.gateway.start(); }
        catch (error) { await this.devices.configure(previous); await this.gateway.start().catch(() => {}); throw error; }
      }
    }
  }
  async close() {
    await this.operations;
    await this.gateway.close();
    if (this.management) { this.management.closeAllConnections(); await new Promise<void>(resolve => this.management!.close(() => resolve())); this.management = undefined; }
    if (this.descriptor) await unlink(this.descriptor).catch(() => {});
  }
}

/** Headless equivalent of safeStorage. The private service directory owns this key. */
export async function createHeadlessRealtimeVoice(root: string, proxy: () => Promise<string> = async () => '') {
  const file = join(root, 'config', 'voice-secret.key'); await mkdir(join(root, 'config'), { recursive: true, mode: 0o700 });
  try { await writeFile(file, randomBytes(32), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const key = await readFile(file); if (key.length !== 32) throw Error('Invalid voice secret store.');
  return new RealtimeVoiceService(join(root, 'voice-realtime-settings.json'), {
    encrypt(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64'); },
    decrypt(value) { const bytes = Buffer.from(value, 'base64'); if (bytes.length < 28) throw Error('Invalid voice credential.'); const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8'); },
    connect: async (url, headers) => connectRealtimeVoice(await proxy(), url, headers),
  });
}
