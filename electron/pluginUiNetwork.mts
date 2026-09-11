import type { Session, App, Event, WebContents, AuthenticationResponseDetails, AuthInfo } from 'electron';
import type { PluginNetwork } from './pluginNetwork.mjs';

/** Chromium's embedded frames share the window session. Route their native
 * requests through the global plugin proxy, separately from model networking. */
export class PluginUiNetwork {
  private applied = '';
  private pending: Promise<void> = Promise.resolve();
  private credentials?: { host: string; port: number; username: string; password: string };
  constructor(private readonly network: PluginNetwork, private readonly session: Session, private readonly app: App) {
    app.on('login', this.login);
  }

  refresh(): Promise<void> {
    // Read configuration inside the queue: an older read cannot finish last and
    // restore the previous proxy after a more recent save.
    const pending = this.pending.catch(() => {}).then(async () => {
      const config = (await this.network.configuration()).default;
      const key = JSON.stringify(config);
      if (key === this.applied) return;
      const endpoint = await this.network.endpoint(config);
      const route = endpoint ? new URL(endpoint) : undefined;
      const credentials = route ? { host: route.hostname, port: Number(route.port), username: decodeURIComponent(route.username), password: decodeURIComponent(route.password) } : undefined;
      if (route) { route.username = ''; route.password = ''; }
      const previous = this.credentials;
      this.credentials = credentials;
      try {
        await this.session.setProxy(route ? { mode: 'fixed_servers', proxyRules: route.origin, proxyBypassRules: '<-loopback>' } : { mode: 'direct' });
      } catch (error) { this.credentials = previous; throw error; }
      // Chromium may reuse an old proxy connection unless its pool is drained.
      await this.session.closeAllConnections();
      this.applied = key;
    });
    this.pending = pending;
    return pending;
  }

  private login = (event: Event, contents: WebContents, _details: AuthenticationResponseDetails, auth: AuthInfo, callback: (username?: string, password?: string) => void) => {
    const credentials = this.credentials;
    if (!credentials || !auth?.isProxy || contents?.session !== this.session || auth.host !== credentials.host || auth.port !== credentials.port) return;
    event.preventDefault(); callback(credentials.username, credentials.password);
  };

  dispose() { this.app.removeListener('login', this.login); }
}
