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
// Initial trust comes from a native CardBush consent dialog. Key agreement
// prevents discovery probes from exposing a reusable credential to other ports.
async function requestConnectorPairing(identity, { signal, onPrepared, confirm, ports = CONNECTOR_DISCOVERY_PORTS,
  attemptTimeoutMs = 750, approvalTimeoutMs = 95_000 } = {}) {
  const browser = connectorBrowser();
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const publicKey = connectorHex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  const problem = code => Object.assign(new Error({
    connection_denied: '连接申请未获同意。需要连接时，请点击「连接 CardBush」重新申请。',
    connection_revoked: '连接已被移除。需要连接时，请点击「连接 CardBush」重新申请。',
    identity_conflict: '连接凭据已改变，请点击「连接 CardBush」重新申请。',
    connection_limit: '浏览器连接记录已满，请先在 CardBush 设置中移除不用的连接。',
    approval_busy: '另一个连接申请正在处理，请稍候。',
  }[code] || '请先启动 CardBush App 或本机 CLI，并开启 Browser Use 插件。'), { code });
  for (const port of ports) {
    if (signal?.aborted) throw problem('cancelled');
    const result = await new Promise(resolve => {
      const consentAbort = new AbortController();
      let socket, finished = false, secret = '', challengeSeen = false, confirmationStarted = false, locallyConfirmed = false, queue = Promise.resolve();
      const nonce = connectorHex(crypto.getRandomValues(new Uint8Array(32)));
      const finish = value => {
        if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); consentAbort.abort();
        if (socket) { socket.onmessage = null; socket.onclose = null; socket.onerror = () => {}; try { socket.close(); } catch {} }
        resolve(value);
      };
      const cancel = () => finish({ error: 'cancelled' });
      let timer = setTimeout(() => finish(null), attemptTimeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      try { socket = new WebSocket(`ws://127.0.0.1:${port}/request-connection`, 'cardbush-pair-v1'); }
      catch { finish(null); return; }
      socket.onopen = () => { queue = queue.then(async () => {
        let resumeProof;
        if (identity.pending) {
          const pending = parseConnectorPairing(identity.pending);
          if (pending.id === identity.id && identity.confirmed === true) {
            locallyConfirmed = true; secret = pending.secret; resumeProof = await connectorHmac(secret, `resume:${identity.id}:${nonce}`);
          }
        }
        if (!finished) socket.send(JSON.stringify({ type: 'pair_request', id: identity.id, browser, key: publicKey, nonce, resumeProof }));
      }).catch(() => finish(null)); };
      socket.onmessage = event => { queue = queue.then(async () => {
        if (finished || typeof event.data !== 'string' || event.data.length > 4096) return;
        const message = JSON.parse(event.data);
        if (message.type === 'pair_error') { finish({ error: message.code }); return; }
        if (message.type === 'pair_challenge' && !challengeSeen && /^04[a-f0-9]{128}$/.test(message.key)) {
          challengeSeen = true; locallyConfirmed = false; clearTimeout(timer);
          timer = setTimeout(() => finish({ error: 'connection_denied' }), approvalTimeoutMs);
          const serverKey = await crypto.subtle.importKey('raw', new Uint8Array(message.key.match(/../g).map(value => parseInt(value, 16))),
            { name: 'ECDH', namedCurve: 'P-256' }, false, []);
          const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, keys.privateKey, 256));
          const context = new TextEncoder().encode(`cardbush-pair-v1:${identity.id}:${browser}:${message.key}`);
          const material = new Uint8Array(shared.length + context.length); material.set(shared); material.set(context, shared.length);
          secret = connectorHex(new Uint8Array(await crypto.subtle.digest('SHA-256', material)));
          const code = `CB2.${port}.${identity.id}.${secret}`;
          // Persist provisional material before asking. If the worker loses the
          // approval reply it can prove the same identity without a second dialog.
          await onPrepared(code);
          const proof = await connectorHmac(secret, `request:${identity.id}:${nonce}`);
          if (!finished) socket.send(JSON.stringify({ type: 'pair_confirm', proof }));
        } else if (message.type === 'pair_waiting' && challengeSeen) {
          if (!finished) socket.send('{"type":"pair_ping"}');
        } else if (message.type === 'pair_allowed' && challengeSeen && !confirmationStarted
          && message.proof === await connectorHmac(secret, `allowed:${identity.id}:${nonce}`)) {
          confirmationStarted = true; clearTimeout(timer);
          timer = setTimeout(() => finish({ error: 'connection_denied' }), 60_000);
          // A fabricated local service can claim host consent. Only this
          // extension's own UI may grant browser-side access on first use.
          void (async () => {
            if (typeof confirm !== 'function' || !await confirm(consentAbort.signal)) { finish({ error: 'connection_denied' }); return; }
            if (finished) return;
            await onPrepared(`CB2.${port}.${identity.id}.${secret}`, true);
            const proof = await connectorHmac(secret, `accept:${identity.id}:${nonce}`);
            if (!finished) { locallyConfirmed = true; socket.send(JSON.stringify({ type: 'pair_accept', proof })); }
          })().catch(() => finish({ error: 'connection_denied' }));
        } else if (message.type === 'pair_approved' && locallyConfirmed && secret && message.proof === await connectorHmac(secret, `approved:${identity.id}:${nonce}`)) {
          finish({ code: `CB2.${port}.${identity.id}.${secret}` });
        }
      }).catch(() => finish(null)); };
      socket.onclose = socket.onerror = () => { void queue.then(() => finish(null)); };
    });
    if (result?.code) return result;
    if (result?.error) throw problem(result.error);
  }
  throw problem('connector_unavailable');
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
