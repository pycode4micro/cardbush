import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import type { Client, ClientChannel } from 'ssh2';
import type { buildConnector } from 'undici';

export interface SshTunnel {
  connect: buildConnector.connector;
  closed: Promise<void>;
  close(): Promise<void>;
}

/** Give ssh2 channels normal Duplex destruction semantics for the HTTP parser. */
function channelStream(channel: ClientChannel): Duplex {
  const stream = new Duplex({
    allowHalfOpen: false,
    read() { channel.resume(); },
    write(chunk, encoding, callback) { channel.write(chunk, encoding, callback); },
    final(callback) { channel.end(callback); },
    destroy(error, callback) {
      channel.removeListener('data', data);
      channel.removeListener('end', end);
      channel.removeListener('close', close);
      channel.destroy();
      callback(error);
    },
  });
  const data = (chunk: Buffer) => { if (!stream.push(chunk)) channel.pause(); };
  const end = () => stream.push(null);
  // ssh2 can close while the HTTP consumer still has buffered response bytes.
  const close = () => {
    if (channel.readableEnded) stream.push(null);
    else stream.destroy(Error('SSH 通道意外关闭。'));
  };
  channel.on('data', data).once('end', end).once('close', close);
  channel.on('error', (error: Error) => stream.destroy(error));
  // A channel can fail before the HTTP client attaches its listeners.
  stream.on('error', () => undefined);
  return stream;
}

/** HTTP sockets are SSH channels; no local listener or TCP connection is created. */
export async function openSshTunnel(client: Client, remoteHost: string, remotePort: number, signal: AbortSignal): Promise<SshTunnel> {
  signal.throwIfAborted();
  if (!['127.0.0.1', 'localhost', '::1'].includes(remoteHost) || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw Error('请选择有效的服务器回环地址和 Agent 端口。');
  }
  const streams = new Set<Duplex>();
  const pending = new Set<() => void>();
  let stopped = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const close = () => {
    if (stopped) return closed;
    stopped = true;
    signal.removeEventListener('abort', abort);
    client.removeListener('close', abort);
    client.removeListener('error', abort);
    for (const cancel of pending) cancel();
    for (const stream of streams) stream.destroy(Error('SSH 通道已关闭。'));
    streams.clear();
    resolveClosed();
    return closed;
  };
  const abort = () => { void close(); };
  signal.addEventListener('abort', abort, { once: true });
  client.once('close', abort);
  client.once('error', abort);
  const connect: buildConnector.connector = (options, callback) => {
    if (stopped) { callback(Error('SSH 通道已关闭。'), null); return; }
    if (options.protocol !== 'http:' || options.hostname.replace(/^\[|\]$/g, '') !== remoteHost || Number(options.port || 80) !== remotePort) {
      callback(Error('SSH 通道目标与 Agent 配置不一致。'), null); return;
    }
    let settled = false;
    const finish = (error: Error | null, channel?: ClientChannel) => {
      if (settled) { channel?.destroy(); return; }
      settled = true; clearTimeout(timer); pending.delete(cancel);
      if (error || stopped || !channel) { channel?.destroy(); callback(error ?? Error('SSH 通道已关闭。'), null); return; }
      const stream = channelStream(channel);
      streams.add(stream); stream.once('close', () => streams.delete(stream));
      // Undici HTTP/1 uses the Duplex interface; TCP-specific methods are optional.
      callback(null, stream as Socket);
    };
    const cancel = () => finish(Error('SSH 通道已关闭。'));
    const timer = setTimeout(() => finish(Object.assign(Error('SSH 通道连接超时。'), { code: 'ETIMEDOUT' })), 10_000);
    timer.unref(); pending.add(cancel);
    try { client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (error, channel) => finish(error ?? null, channel)); }
    catch (error) { finish(error instanceof Error ? error : Error(String(error))); void close(); }
  };
  return { connect, closed, close };
}
