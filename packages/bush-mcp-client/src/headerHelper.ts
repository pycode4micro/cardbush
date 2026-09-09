import { spawn } from 'node:child_process';

export function mcpHeaderFetch(serverUrl: string, helper: { command: string; cwd?: string; env: Record<string, string> }, baseFetch: typeof fetch = fetch): typeof fetch {
  const origin = new URL(serverUrl).origin;
  let current: Promise<Record<string, string>> | undefined;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) return baseFetch(input, init);
    const before = current ??= readHeaders(helper);
    const send = async (headers: Record<string, string>) => {
      const combined = new Headers(headers);
      new Headers(input instanceof Request ? input.headers : undefined).forEach((value, key) => combined.set(key, value));
      new Headers(init?.headers).forEach((value, key) => combined.set(key, value));
      // Custom credentials must never follow a redirect into another origin.
      return baseFetch(input instanceof Request ? input.clone() : input, { ...init, headers: combined, redirect: 'error' });
    };
    const first = await before;
    const response = await send(first);
    if (![401, 403].includes(response.status) || /insufficient_scope/i.test(response.headers.get('www-authenticate') ?? '')) return response;
    if (current === before) current = readHeaders(helper);
    const next = await current;
    if (JSON.stringify(first) === JSON.stringify(next)) return response;
    await response.body?.cancel();
    return send(next);
  };
}

async function readHeaders(helper: { command: string; cwd?: string; env: Record<string, string> }): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh', windows ? ['-NoProfile', '-NonInteractive', '-Command', helper.command] : ['-c', helper.command],
      { cwd: helper.cwd, env: { ...process.env, ...helper.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = []; let bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP HTTP header helper timed out.')); }, 10_000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) { child.kill(); reject(new Error('MCP HTTP header helper output is too large.')); } else chunks.push(chunk); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('MCP HTTP header helper could not start.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error('MCP HTTP header helper failed.')); return; }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) throw new Error();
        const headers = new Headers(value);
        if (['host', 'content-length', 'transfer-encoding', 'connection'].some(key => headers.has(key))) throw new Error();
        resolve(Object.fromEntries(headers));
      } catch { reject(new Error('MCP HTTP header helper must output a JSON object of header strings.')); }
    });
  });
}
