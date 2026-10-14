// This transport deliberately exposes the small Port API used by browser
// operations, keeping authorization and tab isolation independent of transport.
// Shared with electron/chromeConnectorConstants.ts; only these loopback
// endpoints and the saved pairing endpoint may be tried.
const CONNECTOR_DISCOVERY_PORTS = Object.freeze(Array.from({ length: 32 }, (_, index) => 43120 + index * 137));
function parseConnectorPairing(code) {
  const match = /^CB2\.(\d{4,5})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(String(code || '').trim());
  if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) {
    throw new Error('请从 CardBush 浏览器设置中复制有效的配对码。');
  }
  return { port: Number(match[1]), id: match[2], secret: match[3] };
}
function connectorHex(bytes) { return [...bytes].map(value => value.toString(16).padStart(2, '0')).join(''); }
function connectorBrowser() {
  const brands = globalThis.navigator?.userAgentData?.brands ?? [];
  if (brands.some(value => value.brand === 'Microsoft Edge') || /Edg\//.test(globalThis.navigator?.userAgent ?? '')) return 'edge';
  if (brands.some(value => value.brand === 'Google Chrome') || /Chrome\//.test(globalThis.navigator?.userAgent ?? '')) return 'chrome';
  throw new Error('Browser Use 目前支持 Windows 11 上的 Chrome 和 Edge。');
}
async function connectorHmac(secret, text) {
  const bytes = new Uint8Array(secret.match(/../g).map(value => parseInt(value, 16)));
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return connectorHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))));
}
function createConnectorPort(pairing, { attemptTimeoutMs = 1000 } = {}) {
  const messages = new Set(), disconnects = new Set();
  const attempts = new Set();
  let socket = null, endpointPort = null, closed = false, ready = false, heartbeat;
  let lastHeartbeat = Date.now();
  const closeSocket = candidate => {
    if (!candidate) return;
    candidate.onmessage = null; candidate.onclose = null; candidate.onerror = () => {};
    try { candidate.close(); } catch { /* Already closed or still connecting. */ }
  };
  const port = {
    onMessage: { addListener: callback => messages.add(callback) },
    onDisconnect: { addListener: callback => disconnects.add(callback) },
    get endpointPort() { return ready ? endpointPort : null; },
    postMessage(message) {
      if (ready && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    disconnect() {
      if (closed) return;
      closed = true; ready = false; clearInterval(heartbeat);
      for (const cancel of [...attempts]) cancel();
      closeSocket(socket);
      for (const callback of disconnects) callback();
    },
  };
  const fail = (code, message) => {
    if (closed) return;
    for (const callback of messages) callback({ type: 'connector_error', code, message });
    port.disconnect();
  };
  const tryEndpoint = (candidatePort, browser) => new Promise(resolve => {
    if (closed || ready) { resolve(false); return; }
    let candidate, finished = false, challengeSeen = false, serverVerified = false;
    const finish = success => {
      if (finished) return;
      finished = true; clearTimeout(timer); attempts.delete(cancel);
      if (!success) closeSocket(candidate);
      resolve(success);
    };
    const cancel = () => finish(false);
    const timer = setTimeout(cancel, attemptTimeoutMs);
    attempts.add(cancel);
    void (async () => {
      const nonce = connectorHex(crypto.getRandomValues(new Uint8Array(32)));
      const proof = await connectorHmac(pairing.secret, `upgrade:${pairing.id}:${nonce}`);
      if (closed || ready || finished) { finish(false); return; }
      candidate = new WebSocket(`ws://127.0.0.1:${candidatePort}/connect`, ['cardbush-v2', `auth.${pairing.id}.${nonce}.${proof}`]);
      // Unknown services and other CardBush users cannot authenticate with this
      // pairing. A failed candidate never receives browser data or commands.
      candidate.onerror = candidate.onclose = () => {
        if (ready && socket === candidate) fail('connector_disconnected', 'CardBush 连接已断开，等待自动重连。');
        else finish(false);
      };
      candidate.onmessage = event => { void (async () => {
        if (closed || (finished && socket !== candidate)) return;
        if (typeof event.data !== 'string') throw new Error('Invalid message');
        const message = JSON.parse(event.data);
        if (!ready && message.type === 'challenge' && !challengeSeen) {
          challengeSeen = true;
          if (message.protocol !== 'cardbush.chrome_connector.v1' || !/^[a-f0-9]{64}$/.test(message.nonce)) throw new Error('Invalid challenge');
          const transcript = `${pairing.id}:${nonce}:${message.nonce}`;
          if (message.proof !== await connectorHmac(pairing.secret, `server:${transcript}`)) throw new Error('Untrusted broker');
          const proof = await connectorHmac(pairing.secret, `client:${transcript}:${browser}`);
          if (closed || ready || finished) return;
          serverVerified = true;
          candidate.send(JSON.stringify({ type: 'authenticate', browser, proof }));
          return;
        }
        if (!ready) {
          if (!serverVerified || message.type !== 'connector_ready' || message.protocol !== 'cardbush.chrome_connector.v1') throw new Error('Handshake required');
          ready = true; socket = candidate; endpointPort = candidatePort;
          finish(true);
          for (const cancel of [...attempts]) cancel();
          lastHeartbeat = Date.now();
          heartbeat = setInterval(() => {
            if (Date.now() - lastHeartbeat > 60_000) { fail('connector_timeout', 'CardBush 暂时没有响应，等待自动重连。'); return; }
            port.postMessage({ type: 'heartbeat' });
          }, 20_000);
        }
        if (socket !== candidate) return;
        if (message.type === 'heartbeat_ack') { lastHeartbeat = Date.now(); return; }
        for (const callback of messages) callback(message);
      })().catch(() => {
        if (ready && socket === candidate) fail('connector_handshake_failed', '连接校验未通过，未开放浏览器控制。请确认连接的是原来配对的 CardBush。');
        else finish(false);
      }); };
    })().catch(() => finish(false));
  });
  void (async () => {
    const browser = connectorBrowser();
    if (await tryEndpoint(pairing.port, browser) || closed) return;
    const candidates = CONNECTOR_DISCOVERY_PORTS.filter(value => value !== pairing.port);
    let next = 0;
    // At most four probes at once, each with a deadline. Reconnect backoff is
    // owned by the background worker, so unavailable services never spin.
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (!closed && !ready && next < candidates.length) await tryEndpoint(candidates[next++], browser);
    }));
    if (!closed && !ready) fail('connector_unavailable', '暂时无法连接 CardBush，请确认应用和本机连接器已开启。已保存的配对与网站授权保持不变。');
  })().catch(() => fail('connector_unavailable', '暂时无法建立 CardBush 本地连接，等待自动重连。'));
  return port;
}
