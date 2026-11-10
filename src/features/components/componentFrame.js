// Runs inside the opaque component iframe. The host checks the sender, token and grants.
(() => {
  const { protocol, token, network } = document.currentScript.dataset;
  const pending = new Map();
  const listeners = new Map();
  let sequence = 0;
  let context = null;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  function request(method, params = {}) {
    if (pending.size >= 8) return Promise.reject(new Error('BUSY'));
    return new Promise((resolve, reject) => {
      const id = String(++sequence);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('TIMEOUT; action status may be unknown, do not retry automatically'));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      parent.postMessage({ protocol, token, jsonrpc: '2.0', id, method, params }, '*');
    });
  }

  addEventListener('message', event => {
    const message = event.data;
    if (event.source !== parent || message?.protocol !== protocol || message.token !== token) return;
    if (message.id) {
      const rpc = pending.get(message.id);
      if (!rpc) return;
      clearTimeout(rpc.timer);
      pending.delete(message.id);
      if (message.error) rpc.reject(new Error(message.error));
      else rpc.resolve(message.result);
      return;
    }
    if (message.topic === 'host.context') {
      context = message.value;
      resolveReady(context);
    }
    if (message.topic === 'theme.changed') {
      const root = document.documentElement;
      root.dataset.reduceMotion = String(message.value['--cb-reduced-motion'] === '1');
      for (const [key, value] of Object.entries(message.value)) root.style.setProperty(key, String(value));
    }
    for (const callback of listeners.get(message.topic) ?? []) {
      try { callback(message.value); } catch (error) { console.error(error); }
    }
  });

  window.cardbush = Object.freeze({
    version: 1,
    ready,
    get context() { return context; },
    read: () => request('context.read'),
    state: { read: () => request('state.read'), write: value => request('state.write', { value }) },
    net: network === 'true' ? Object.freeze({ fetchJson: url => request('net.fetchJson', { url }) }) : undefined,
    subscribe(topic, callback) {
      if (!listeners.has(topic)) listeners.set(topic, new Set());
      listeners.get(topic).add(callback);
      return () => listeners.get(topic)?.delete(callback);
    },
    async invoke(command, args = {}, key) {
      await ready;
      const idempotencyKey = key || crypto.getRandomValues(new Uint32Array(4)).join('-');
      return request('actions.invoke', { command, args, contextRevision: context?.revision, idempotencyKey });
    },
  });
})();
