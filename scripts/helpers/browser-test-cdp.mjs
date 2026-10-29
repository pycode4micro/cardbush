import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function until(read, label, timeout = 45000) {
  const end = Date.now() + timeout;
  do { const result = await read(); if (result) return result; await delay(100); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}

// TCP DevTools works with both Chromium distributions on Windows; unlike the
// inherited pipe it also supplies a useful startup/early-process-exit diagnosis.
export class BrowserTestCdp {
  pending = new Map(); sequence = 0;
  async connect(child, { profilePath, allowRelaunch = false } = {}) {
    let stderr = '', ended = false;
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
    child.once('exit', () => { ended = true; if (!allowRelaunch) this.close(); });
    child.once('error', error => { stderr += error.message; ended = true; });
    const endpoint = await until(async () => {
      const found = /DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(stderr)?.[1];
      if (found) return found;
      // Edge may replace its launcher process and drop inherited stderr/pipe
      // handles. The private profile publishes the new process's TCP endpoint.
      if (profilePath) {
        const lines = await fs.readFile(path.join(profilePath, 'DevToolsActivePort'), 'utf8').catch(() => '');
        const [port, endpointPath] = lines.trim().split(/\r?\n/);
        if (/^\d+$/.test(port) && /^\/devtools\/browser\/[\w-]+$/.test(endpointPath)) return `ws://127.0.0.1:${port}${endpointPath}`;
      }
      if (ended && !allowRelaunch) throw Error(`Fixture exited before DevTools: ${stderr.slice(-2000)}`);
      return found;
    }, 'fixture DevTools endpoint', 20000).catch(error => { throw Error(`${error.message}\n${stderr.slice(-2000)}`); });
    this.socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('DevTools socket timeout')), 5000);
      this.socket.onopen = () => { clearTimeout(timer); resolve(); };
      this.socket.onerror = () => { clearTimeout(timer); reject(Error('DevTools socket failed')); };
    });
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method) { this.onEvent?.(message); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result);
    };
    this.socket.onclose = () => this.close();
    return this;
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(expression, sessionId) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  close() {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(Error('Fixture DevTools closed')); }
    this.pending.clear();
    if (this.socket) { this.socket.onclose = null; this.socket.close(); }
  }
}
