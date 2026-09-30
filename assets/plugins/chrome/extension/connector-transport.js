// This transport deliberately exposes the small Port API used by browser
// operations, keeping authorization and tab isolation independent of transport.
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
function createConnectorPort(pairing) {
  const messages = new Set(), disconnects = new Set();
  let socket = null, closed = false, ready = false, challengeSeen = false, serverVerified = false, heartbeat;
  let lastHeartbeat = Date.now();
  const nonce = connectorHex(crypto.getRandomValues(new Uint8Array(32)));
  const port = {
    onMessage: { addListener: callback => messages.add(callback) },
    onDisconnect: { addListener: callback => disconnects.add(callback) },
    postMessage(message) {
      if (ready && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    disconnect() {
      if (closed) return;
      closed = true; ready = false; clearInterval(heartbeat); socket?.close();
      for (const callback of disconnects) callback();
    },
  };
  const fail = (code, message) => {
    if (closed) return;
    for (const callback of messages) callback({ type: 'connector_error', code, message });
    port.disconnect();
  };
  void (async () => {
    const browser = connectorBrowser();
    const proof = await connectorHmac(pairing.secret, `upgrade:${pairing.id}:${nonce}`);
    if (closed) return;
    socket = new WebSocket(`ws://127.0.0.1:${pairing.port}/connect`, ['cardbush-v2', `auth.${pairing.id}.${nonce}.${proof}`]);
    // WebSocket errors do not expose whether the app is offline or an upgrade
    // was rejected. Never infer credential revocation from a network failure.
    socket.onerror = () => fail('connector_unavailable', '暂时无法连接 CardBush，请确认应用和本机连接器已开启。已保存的配对与网站授权保持不变。');
    socket.onclose = () => fail('connector_disconnected', 'CardBush 连接已断开，等待自动重连。');
    socket.onmessage = event => { void (async () => {
      if (closed || typeof event.data !== 'string') return;
      const message = JSON.parse(event.data);
      if (!ready && message.type === 'challenge' && !challengeSeen) {
        challengeSeen = true;
        if (message.protocol !== 'cardbush.chrome_connector.v1' || !/^[a-f0-9]{64}$/.test(message.nonce)) throw new Error('Invalid challenge');
        const transcript = `${pairing.id}:${nonce}:${message.nonce}`;
        if (message.proof !== await connectorHmac(pairing.secret, `server:${transcript}`)) throw new Error('Untrusted broker');
        const proof = await connectorHmac(pairing.secret, `client:${transcript}:${browser}`);
        if (closed) return;
        serverVerified = true;
        socket.send(JSON.stringify({ type: 'authenticate', browser, proof }));
        return;
      }
      if (!ready) {
        if (!serverVerified || message.type !== 'connector_ready' || message.protocol !== 'cardbush.chrome_connector.v1') throw new Error('Handshake required');
        ready = true;
        lastHeartbeat = Date.now();
        heartbeat = setInterval(() => {
          if (Date.now() - lastHeartbeat > 60_000) { fail('connector_timeout', 'CardBush 暂时没有响应，等待自动重连。'); return; }
          port.postMessage({ type: 'heartbeat' });
        }, 20_000);
      }
      if (message.type === 'heartbeat_ack') { lastHeartbeat = Date.now(); return; }
      for (const callback of messages) callback(message);
    })().catch(() => fail('connector_handshake_failed', '连接校验未通过，未开放浏览器控制。请确认连接的是原来配对的 CardBush；仅在移除过配对或更换应用配置时重新配对。')); };
  })().catch(() => fail('connector_unavailable', '暂时无法建立 CardBush 本地连接，等待自动重连。'));
  return port;
}
