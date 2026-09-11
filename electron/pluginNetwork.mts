import { createHash, randomBytes } from 'node:crypto';
import { createServer, request, type IncomingMessage, type Server, type ClientRequest } from 'node:http';
import { request as secureRequest } from 'node:https';
import { connect, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { networkProxySchema, pluginProxySchema, resolvePluginProxy, normalizeProxyAddress, pluginProxyEnvironment,
  type NetworkProxySettings } from '@cardbush/bush-protocol';
import { ProxyFetchPool } from './proxyFetch.mjs';

type ProxySession = { setProxy(config: { mode: 'system' | 'fixed_servers'; proxyRules?: string; proxyBypassRules?: string }): Promise<void>; resolveProxy(url: string): Promise<string> };
type Route = { endpoint: string; server: Server; sockets: Set<Socket>; resolve: (url: string) => Promise<string> };

/** One isolated route per effective configuration. Existing children retain their route until closed. */
export class PluginNetwork {
  private model: NetworkProxySettings = { mode: 'none', httpProxy: '', httpsProxy: '', noProxy: '' };
  private routes = new Map<string, Promise<Route>>();
  private fetches = new ProxyFetchPool();
  constructor(private readonly configPath: string, private readonly createSession: (partition: string) => ProxySession) {}

  setModel(value: unknown) { this.model = networkProxySchema.parse(value); }

  async configuration() {
    let stored: { proxy?: unknown; plugins?: Array<{ id: string; config?: { proxy?: unknown } }> } = {};
    try { stored = JSON.parse(await readFile(this.configPath, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const defaults = stored.proxy === undefined ? undefined : pluginProxySchema.parse(stored.proxy);
    let mcp: { servers?: Array<{ id: string; proxy?: unknown }> } = {};
    try { mcp = JSON.parse(await readFile(join(dirname(this.configPath), 'mcp-servers.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { default: resolvePluginProxy(this.model, defaults), plugins: Object.fromEntries((stored.plugins ?? []).map(plugin =>
      [plugin.id, resolvePluginProxy(this.model, defaults, plugin.config?.proxy === undefined ? undefined : pluginProxySchema.parse(plugin.config.proxy))])),
      servers: Object.fromEntries((mcp.servers ?? []).map(server => [server.id, resolvePluginProxy(this.model, defaults, server.proxy == null ? undefined : pluginProxySchema.parse(server.proxy))])) };
  }

  async endpoint(value: unknown): Promise<string> {
    const config = networkProxySchema.parse(value);
    if (config.mode === 'none') return '';
    const key = JSON.stringify(config);
    let pending = this.routes.get(key);
    if (!pending) {
      pending = this.createRoute(config, key);
      this.routes.set(key, pending);
      void pending.catch(() => { if (this.routes.get(key) === pending) this.routes.delete(key); });
    }
    return (await pending).endpoint;
  }

  async environment(pluginId?: string) {
    const config = await this.configuration();
    return pluginProxyEnvironment(await this.endpoint(config.plugins[pluginId ?? ''] ?? config.default));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const config = await this.configuration();
    return this.fetches.forEndpoint(await this.endpoint(config.default))(input, init);
  };

  async close() {
    await this.fetches.close();
    for (const pending of this.routes.values()) {
      const route = await pending.catch(() => undefined);
      if (route) { for (const socket of route.sockets) socket.destroy(); route.server.close(); }
    }
    this.routes.clear();
  }

  private async createRoute(config: NetworkProxySettings, key: string): Promise<Route> {
    const session = this.createSession(`cardbush-plugin-network-${createHash('sha256').update(key).digest('hex')}`);
    if (config.mode === 'system') await session.setProxy({ mode: 'system' });
    else await session.setProxy({ mode: 'fixed_servers', proxyRules: [
      config.httpProxy ? `http=${withoutCredentials(config.httpProxy)}` : '',
      config.httpsProxy ? `https=${withoutCredentials(config.httpsProxy)}` : '',
    ].filter(Boolean).join(';'), proxyBypassRules: config.noProxy.replaceAll(',', ';') });
    const resolve = async (target: string) => {
      const result = await session.resolveProxy(target);
      const first = result.split(';')[0]?.trim();
      if (first === 'DIRECT') return '';
      const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5) (.+)$/.exec(first ?? '');
      if (!match) throw new Error('System proxy returned an unsupported route.');
      const protocol = ({ PROXY: 'http', HTTPS: 'https', SOCKS: 'socks5h', SOCKS4: 'socks4', SOCKS5: 'socks5h' } as Record<string, string>)[match[1]];
      const address = `${protocol}://${match[2]}`;
      // Chromium returns route identity without credentials; retain the user-provided proxy credentials locally.
      const manual = new URL(target).protocol === 'https:' ? config.httpsProxy : config.httpProxy;
      if (config.mode === 'manual' && manual && new URL(normalizeProxyAddress(manual)).host === new URL(address).host) return normalizeProxyAddress(manual);
      return address;
    };
    const auth = `Basic ${Buffer.from(`cardbush:${randomBytes(24).toString('hex')}`).toString('base64')}`;
    const sockets = new Set<Socket>();
    const server = createServer((incoming, outgoing) => {
      if (incoming.headers['proxy-authorization'] !== auth) { outgoing.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="CardBush"' }).end(); return; }
      let upstream: ClientRequest | undefined;
      outgoing.on('close', () => upstream?.destroy());
      void (async () => {
        const url = new URL(incoming.url ?? '');
        if (url.protocol !== 'http:' || url.username || url.password) throw new Error('Invalid proxy target.');
        const proxy = await resolve(url.href);
        if (outgoing.destroyed) return;
        const agent = !proxy ? false : proxy.startsWith('socks') ? new SocksProxyAgent(proxy, { timeout: 15_000 }) : new HttpProxyAgent(proxy);
        const headers: IncomingMessage['headers'] = { ...incoming.headers, host: url.host };
        for (const name of ['proxy-authorization', 'proxy-connection', ...(String(headers.connection ?? '').toLowerCase().split(',').map(value => value.trim()))]) delete headers[name];
        upstream = request(url, { headers, method: incoming.method, agent }, response => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.on('error', () => outgoing.destroy()); response.pipe(outgoing);
        });
        upstream.once('socket', socket => socket.setTimeout(0));
        upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end('Plugin proxy connection failed.'); });
        incoming.on('error', () => upstream?.destroy()); incoming.pipe(upstream);
      })().catch(() => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end('Plugin proxy connection failed.'); });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => socket.destroy()); });
    server.on('connect', (incoming, client, head) => {
      if (incoming.headers['proxy-authorization'] !== auth) {
        // Chromium starts HTTPS tunnels without cached proxy credentials. It
        // needs the challenge to invoke the host login handler and retry CONNECT.
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="CardBush"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return;
      }
      const abort = new AbortController();
      client.once('close', () => abort.abort());
      const timer = setTimeout(() => { abort.abort(); client.destroy(); }, 20_000);
      void (async () => {
        const url = new URL(`https://${incoming.url}`);
        if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid tunnel target.');
        const proxy = await resolve(url.href);
        abort.signal.throwIfAborted();
        const socket = await openTunnel(url, proxy, incoming, abort.signal);
        clearTimeout(timer);
        if (client.destroyed) { socket.destroy(); return; }
        client.once('close', () => socket.destroy()); socket.once('close', () => client.destroy());
        socket.on('error', () => client.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) socket.write(head);
        client.pipe(socket).pipe(client); socket.resume();
      })().catch(() => { clearTimeout(timer); if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
    });
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => { server.off('error', fail); done(); }); });
    const port = (server.address() as { port: number }).port;
    const credentials = Buffer.from(auth.slice(6), 'base64').toString();
    return { endpoint: `http://${credentials}@127.0.0.1:${port}`, server, sockets, resolve };
  }
}

function withoutCredentials(value: string) {
  const url = new URL(normalizeProxyAddress(value)); url.username = ''; url.password = '';
  return url.toString().replace(/\/$/, '').replace(/^socks5h:/, 'socks5:');
}

async function openTunnel(url: URL, proxy: string, incoming: IncomingMessage, signal: AbortSignal): Promise<Socket> {
  const host = url.hostname.replace(/^\[|\]$/g, ''), port = Number(url.port || 443);
  if (proxy.startsWith('socks')) {
    const socket = await new SocksProxyAgent(proxy, { timeout: 15_000 }).connect(incoming as unknown as ClientRequest, { host, port, secureEndpoint: false });
    if (signal.aborted) { socket.destroy(); signal.throwIfAborted(); }
    socket.setTimeout(0);
    return socket;
  }
  return new Promise((done, fail) => {
    if (!proxy) {
      const socket = connect({ host, port, signal });
      socket.once('error', fail); socket.once('connect', () => done(socket)); return;
    }
    const address = new URL(proxy);
    const headers: Record<string, string> = { Host: `${url.hostname}:${port}` };
    if (address.username || address.password) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(address.username)}:${decodeURIComponent(address.password)}`).toString('base64')}`;
    address.username = ''; address.password = '';
    const tunnel = (address.protocol === 'https:' ? secureRequest : request)(address, { method: 'CONNECT', path: headers.Host, headers, signal, agent: false });
    tunnel.once('error', fail);
    tunnel.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); fail(new Error('Upstream proxy rejected the tunnel.')); return; }
      if (head.length) socket.unshift(head);
      done(socket);
    });
    tunnel.end();
  });
}
