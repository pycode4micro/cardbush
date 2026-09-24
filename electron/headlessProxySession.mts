import { normalizeProxyAddress } from '@cardbush/bush-protocol';

/** PluginNetwork's routing adapter for Node services; system proxy means the service environment. */
export function createHeadlessProxySession(env: NodeJS.ProcessEnv) {
  let settings: { mode: 'system' | 'fixed_servers'; proxyRules?: string; proxyBypassRules?: string } = { mode: 'system' };
  return {
    async setProxy(value: typeof settings) { settings = value; },
    async resolveProxy(target: string) {
      const url = new URL(target);
      const system = settings.mode === 'system';
      const bypass = system ? env.no_proxy ?? env.NO_PROXY ?? '' : settings.proxyBypassRules ?? '';
      const host = url.hostname.toLowerCase();
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      if (bypass.split(/[;,\s]+/).some(rule => {
        if (!rule) return false;
        if (rule === '*') return true;
        const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(rule.toLowerCase());
        if (!match || (match[2] && match[2] !== port)) return false;
        const domain = match[1].replace(/^\*?\./, '');
        return host === domain || host.endsWith(`.${domain}`);
      })) return 'DIRECT';
      const proxy = system
        ? (url.protocol === 'https:' ? env.https_proxy ?? env.HTTPS_PROXY : env.http_proxy ?? env.HTTP_PROXY) ?? env.all_proxy ?? env.ALL_PROXY
        : settings.proxyRules?.split(';').find(rule => rule.startsWith(`${url.protocol.slice(0, -1)}=`))?.split('=').slice(1).join('=');
      if (!proxy) return 'DIRECT';
      const address = new URL(normalizeProxyAddress(proxy));
      const kind = ({ 'http:': 'PROXY', 'https:': 'HTTPS', 'socks4:': 'SOCKS4', 'socks5:': 'SOCKS5', 'socks5h:': 'SOCKS5' } as Record<string, string>)[address.protocol];
      if (!kind) throw new Error('Unsupported Agent proxy protocol.');
      // System routes retain env credentials; manual credentials are restored by PluginNetwork.
      const auth = address.username || address.password ? `${address.username}:${address.password}@` : '';
      return `${kind} ${auth}${address.host}`;
    },
  };
}
