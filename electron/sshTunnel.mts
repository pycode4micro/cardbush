import { createServer, type Socket } from 'node:net';
import type { Client, ClientChannel } from 'ssh2';

export interface SshTunnel {
  closed: Promise<void>;
  close(): Promise<void>;
}

/** One loopback listener; closing it never closes the shared SSH connection. */
export async function openSshTunnel(client: Client, localUrl: string, remoteHost: string, remotePort: number, signal: AbortSignal): Promise<SshTunnel> {
  signal.throwIfAborted();
  const url = new URL(localUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('SSH 隧道需要本机回环 HTTP 地址。');
  if (url.port === '0') throw Error('请选择 1–65535 范围内的本机转发端口。');
  const sockets = new Set<Socket>();
  const channels = new Set<ClientChannel>();
  let stopped = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const server = createServer(socket => {
    if (stopped) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.pause();
    try { client.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, remoteHost, remotePort, (error, channel) => {
      if (error || stopped || socket.destroyed) { channel?.destroy(); socket.destroy(); return; }
      channels.add(channel);
      channel.on('error', () => socket.destroy());
      channel.once('close', () => { channels.delete(channel); socket.destroy(); });
      socket.once('close', () => channel.destroy());
      socket.pipe(channel).pipe(socket);
      socket.resume();
    }); } catch { socket.destroy(); void close(); } // SSH may close before its close event reaches this listener.
  });
  const close = () => {
    if (stopped) return closed;
    stopped = true;
    signal.removeEventListener('abort', abort);
    client.removeListener('close', abort);
    client.removeListener('error', abort);
    for (const socket of sockets) socket.destroy();
    for (const channel of channels) channel.destroy();
    server.close(() => resolveClosed());
    return closed;
  };
  const abort = () => { void close(); };
  signal.addEventListener('abort', abort, { once: true });
  client.once('close', abort);
  client.once('error', abort);
  try {
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => reject(Error('SSH 隧道已关闭。'));
      void closed.then(cancelled);
      server.once('error', reject);
      server.listen(Number(url.port || 80), url.hostname === '[::1]' ? '::1' : '127.0.0.1', () => {
        server.removeListener('error', reject);
        server.on('error', abort);
        if (stopped) { server.close(); reject(Error('SSH 隧道已关闭。')); } else resolve();
      });
    });
    signal.throwIfAborted();
    return { closed, close };
  } catch (error) {
    await close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw Error(`本机隧道端口 ${url.port || 80} 已被占用，请关闭原隧道或修改本机转发地址。`);
    throw error;
  }
}
