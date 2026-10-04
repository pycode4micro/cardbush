import { Agent, ProxyAgent, fetch as networkFetch, type Dispatcher, type RequestInit } from 'undici';

/** Per-route dispatchers never change the process-wide fetch or environment. */
export class ProxyFetchPool {
  private readonly routes = new Map<string, Dispatcher>();
  forEndpoint(endpoint: string, routeKey = ''): typeof fetch {
    // A system/PAC route can change behind the same loopback endpoint. A new
    // exit must not reuse an HTTPS tunnel opened through the previous proxy.
    const key = JSON.stringify([endpoint, routeKey]);
    let dispatcher = this.routes.get(key);
    if (!dispatcher) { dispatcher = endpoint ? new ProxyAgent({ uri: endpoint, proxyTunnel: false }) : new Agent(); this.routes.set(key, dispatcher); }
    return async (input, init) => {
      const request = new Request(input, init);
      return await networkFetch(request.url, { method: request.method, headers: Array.from(request.headers.entries()),
        body: request.body as RequestInit['body'],
        duplex: 'half', signal: request.signal, redirect: request.redirect, dispatcher }) as unknown as Response;
    };
  }
  async close() { await Promise.all([...this.routes.values()].map(route => route.destroy())); this.routes.clear(); }
}
