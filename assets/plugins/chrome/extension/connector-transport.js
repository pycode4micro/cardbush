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
  const fail = () => {
    if (closed) return;
    for (const callback of messages) callback({ type: 'connector_error', message: '配对校验失败或连接已断开，请确认 CardBush 已开启；必要时重新生成配对码。' });
    port.disconnect();
  };
  void (async () => {
    const proof = await connectorHmac(pairing.secret, `upgrade:${pairing.id}:${nonce}`);
    if (closed) return;
    socket = new WebSocket(`ws://127.0.0.1:${pairing.port}/connect`, ['cardbush-v2', `auth.${pairing.id}.${nonce}.${proof}`]);
    socket.onerror = fail;
    socket.onclose = fail;
    socket.onmessage = event => { void (async () => {
      if (closed || typeof event.data !== 'string') return;
      const message = JSON.parse(event.data);
      if (!ready && message.type === 'challenge' && !challengeSeen) {
        challengeSeen = true;
        if (message.protocol !== 'cardbush.chrome_connector.v1' || !/^[a-f0-9]{64}$/.test(message.nonce)) throw new Error('Invalid challenge');
        const transcript = `${pairing.id}:${nonce}:${message.nonce}`;
        if (message.proof !== await connectorHmac(pairing.secret, `server:${transcript}`)) throw new Error('Untrusted broker');
        const proof = await connectorHmac(pairing.secret, `client:${transcript}`);
        if (closed) return;
        serverVerified = true;
        socket.send(JSON.stringify({ type: 'authenticate', proof }));
        return;
      }
      if (!ready) {
        if (!serverVerified || message.type !== 'connector_ready' || message.protocol !== 'cardbush.chrome_connector.v1') throw new Error('Handshake required');
        ready = true;
        lastHeartbeat = Date.now();
        heartbeat = setInterval(() => {
          if (Date.now() - lastHeartbeat > 60_000) { fail(); return; }
          port.postMessage({ type: 'heartbeat' });
        }, 20_000);
      }
      if (message.type === 'heartbeat_ack') { lastHeartbeat = Date.now(); return; }
      for (const callback of messages) callback(message);
    })().catch(fail); };
  })().catch(fail);
  return port;
}
