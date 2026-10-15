import { createServer, type Server, type IncomingMessage } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { EmbodiedDeviceStore, type PairedDevice } from './embodiedDevices.mjs';
import { EmbodiedAudioCodec } from './embodiedAudio.mjs';
import type { RealtimeVoiceEvent } from './realtimeVoiceTypes.js';

export interface DeviceVoiceCall {
  start(): Promise<void>; audio(pcm: Uint8Array): void;
  control(action: 'interrupt' | 'commit' | 'mute' | 'unmute'): void;
  playback(speaking: boolean): void; close(): void;
}
const helloSchema = z.object({ type: z.literal('hello'), version: z.literal(1), transport: z.literal('websocket'),
  features: z.object({ mcp: z.boolean().optional(), aec: z.boolean().optional(), cardbush: z.boolean().optional() }).passthrough().optional(),
  audio_params: z.object({ format: z.literal('opus'), sample_rate: z.literal(16000), channels: z.literal(1), frame_duration: z.union([z.literal(20), z.literal(40), z.literal(60)]) }),
}).passthrough();

export class EmbodiedGateway {
  private server?: Server;
  private sockets = new Map<string, WebSocket>();
  private status = new Map<string, { connected: boolean; connectedAt: string; framesIn: number; framesOut: number; interrupts: number;
    handshakeMs?: number; firstInputAt?: string; firstOutputAt?: string; lastError?: string }>();
  constructor(private store: EmbodiedDeviceStore, private create: (device: PairedDevice, emit: (event: RealtimeVoiceEvent) => void) => Promise<DeviceVoiceCall>) {}
  snapshot() { const address = this.server?.address(); return { listening: Boolean(address), port: address && typeof address !== 'string' ? address.port : undefined,
    devices: Object.fromEntries(this.status) }; }
  disconnect(id: string) { this.sockets.get(id)?.close(1008, 'Device revoked'); }
  async start() {
    if (this.server) throw Error('Device listener is already running.');
    const config = (await this.store.read()).listener;
    if (!config.enabled) return this.snapshot();
    const server = config.tlsCert ? createSecureServer({ cert: await readFile(config.tlsCert), key: await readFile(config.tlsKey) }) : createServer();
    server.on('request', (_request, response) => response.writeHead(404).end());
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      void this.authorize(request).then(device => {
        if (!device || this.sockets.has(device.id)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
        // Reserve identity before any further await; simultaneous upgrades cannot steal it.
        wss.handleUpgrade(request, socket, head, ws => this.accept(device, ws));
      }).catch(() => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); }); });
    this.server = server; return this.snapshot();
  }
  private async authorize(request: IncomingMessage) {
    if (request.url !== '/api/embodied/v1/audio' || request.headers.origin || request.headers['protocol-version'] !== '1') return;
    return this.store.authenticate(String(request.headers['device-id'] || ''), String(request.headers.authorization || '').replace(/^Bearer /, ''));
  }
  private accept(device: PairedDevice, ws: WebSocket) {
    this.sockets.set(device.id, ws);
    const acceptedAt = Date.now();
    const status = { connected: false, connectedAt: new Date(acceptedAt).toISOString(), framesIn: 0, framesOut: 0, interrupts: 0,
      handshakeMs: undefined as number | undefined, firstInputAt: undefined as string | undefined, firstOutputAt: undefined as string | undefined, lastError: undefined as string | undefined };
    this.status.set(device.id, status);
    let call: DeviceVoiceCall | undefined, codec: EmbodiedAudioCodec | undefined, started = false, opening = false, closed = false;
    let output = false, playing = false, ended = false, suppressed = false, extension = false, epoch = 0;
    let packets: Buffer[] = [], sendTimer: NodeJS.Timeout | undefined, playbackTimer: NodeJS.Timeout | undefined;
    let intervalFrames = 0, receivedAt = Date.now(), missedPing = false;
    const send = (event: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); };
    const fail = (reason: string) => { status.lastError = reason; send({ type: 'alert', emotion: 'sad', message: reason }); ws.close(1008, reason.slice(0, 120)); };
    const interrupt = () => {
      packets = []; codec?.clear(); clearTimeout(sendTimer); sendTimer = undefined; clearTimeout(playbackTimer);
      output = false; playing = false; ended = false; suppressed = true; epoch++; status.interrupts++;
      send({ type: 'cardbush', action: 'interrupt', epoch }); send({ type: 'tts', state: 'stop' }); call?.playback(false);
    };
    const drain = () => {
      sendTimer = undefined;
      if (closed || !codec) return;
      const packet = packets.shift();
      if (packet) {
        if (ws.bufferedAmount > 64 * 1024) { fail('Audio transport is congested. Reconnect before speaking.'); return; }
        ws.send(packet); status.framesOut++; status.firstOutputAt ??= new Date().toISOString();
        sendTimer = setTimeout(drain, codec.frameMs);
      } else if (ended) {
        ended = false; output = false; send({ type: 'tts', state: 'stop' });
        // Patched firmware acknowledges its actual speaker drain. Legacy clients have a bounded fallback.
        playbackTimer = setTimeout(() => { playing = false; call?.playback(false); }, extension ? 2000 : 250);
      }
    };
    const emit = (event: RealtimeVoiceEvent) => {
      if (closed) return;
      if (event.type === 'audio-start') { suppressed = false; ended = false; }
      if (event.type === 'audio' && !suppressed) {
        if (event.sampleRate !== 24000 || !codec) { fail('Unsupported provider audio.'); return; }
        if (!output) { output = true; playing = true; clearTimeout(playbackTimer); call?.playback(true); send({ type: 'tts', state: 'start' }); }
        packets.push(...codec.encode(Buffer.from(event.pcm, 'base64')));
        if (packets.length * codec.frameMs > 30000) { call?.control('interrupt'); interrupt(); fail('Speech backlog exceeded.'); return; }
        if (!sendTimer) sendTimer = setTimeout(drain, 0);
      } else if (event.type === 'audio-end' && output) {
        packets.push(...codec!.encode(Buffer.alloc(0), true)); ended = true;
        if (!sendTimer) sendTimer = setTimeout(drain, 0);
      } else if (event.type === 'interrupted') interrupt();
      else if (event.type === 'transcript' && event.final) send(event.role === 'user' ? { type: 'stt', text: event.text } : { type: 'tts', state: 'sentence_start', text: event.text });
      else if (event.type === 'connection-state' && event.state !== 'connected') { interrupt(); send({ type: 'cardbush', action: 'reconnecting' }); }
      else if (event.type === 'error') fail('Voice provider unavailable. Check host voice settings and diagnostics.');
      else if (event.type === 'closed') ws.close(1000, 'Voice call closed');
    };
    const deadline = setTimeout(() => fail('Voice handshake timed out.'), 95000);
    const heartbeat = setInterval(() => {
      if (missedPing) { ws.terminate(); return; }
      missedPing = true; ws.ping();
      // The firmware also has an application-level idle timeout; WS pongs do not reset it.
      if (started && extension) send({ type: 'cardbush', action: 'heartbeat' });
    }, 30000);
    ws.on('pong', () => { missedPing = false; });
    ws.on('message', (raw, binary) => {
      if (closed) return;
      try {
        if (Date.now() - receivedAt >= 1000) { receivedAt = Date.now(); intervalFrames = 0; }
        if (++intervalFrames > 100) throw Error('Device frame rate exceeded.');
        if (binary) {
          if (!started || !codec || !call) throw Error('Audio before handshake.');
          const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
          for (const frame of codec.decode(bytes)) call.audio(frame);
          status.framesIn++; status.firstInputAt ??= new Date().toISOString(); return;
        }
        const event = JSON.parse(raw.toString());
        if (!started) {
          if (opening) throw Error('Duplicate hello.');
          const hello = helloSchema.parse(event); opening = true; extension = hello.features?.cardbush === true;
          if (hello.features?.aec) throw Error('Server AEC is not supported. Use the CardBush device-AEC firmware.');
          codec = new EmbodiedAudioCodec(hello.audio_params.frame_duration);
          void this.create(device, emit).then(async created => {
            call = created; if (closed) { call.close(); return; }
            await call.start(); if (closed) { call.close(); return; }
            started = true; status.connected = true; status.handshakeMs = Date.now() - acceptedAt; clearTimeout(deadline);
            send({ type: 'hello', version: 1, session_id: 'personal-assistant', transport: 'websocket',
              features: { cardbush: true }, audio_params: { format: 'opus', sample_rate: 24000, channels: 1, frame_duration: codec!.frameMs } });
          }).catch(() => fail('Assistant unavailable or already in a call. Check the host.'));
          return;
        }
        if (event.type === 'abort') { call!.control('interrupt'); interrupt(); }
        else if (event.type === 'listen') {
          if (event.state === 'stop') call!.control('commit');
          else if (event.state === 'start' && !['auto', 'realtime', 'manual'].includes(event.mode)) throw Error('Invalid listening mode.');
        } else if (event.type === 'cardbush' && extension) {
          if (event.action === 'playback' && typeof event.speaking === 'boolean') { clearTimeout(playbackTimer); playing = event.speaking; call!.playback(playing); }
          else if (event.action === 'speech' && event.speaking === true && (output || playing)) { call!.control('interrupt'); interrupt(); }
        } else if (event.type !== 'mcp') throw Error('Unsupported device message.');
        // Device MCP announcements are not tools approved for this assistant.
      } catch { fail('Invalid device protocol message.'); }
    });
    const dispose = () => {
      if (closed) return; closed = true; clearTimeout(deadline); clearInterval(heartbeat); clearTimeout(sendTimer); clearTimeout(playbackTimer);
      call?.close(); codec?.close(); packets = []; status.connected = false;
      if (this.sockets.get(device.id) === ws) this.sockets.delete(device.id);
    };
    ws.on('close', dispose); ws.on('error', dispose);
  }
  async close() {
    for (const ws of this.sockets.values()) ws.terminate();
    this.sockets.clear();
    const server = this.server; this.server = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}
