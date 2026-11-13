// Runs inside the opaque component iframe. The host checks the sender, token and grants.
(() => {
  const { protocol, token, network } = document.currentScript.dataset;
  // Keep this capability inside the trusted click listener, outside the widget SDK.
  const linkKey = document.currentScript.dataset.linkKey;
  delete document.currentScript.dataset.linkKey;
  if (linkKey) {
    const send = parent.postMessage.bind(parent);
    // Report iframe destinations, not load success: cross-origin pages cannot
    // be inspected reliably. The host validates every address independently.
    let pulse = 0, last;
    const report = () => {
      pulse = 0;
      const sites = new Map();
      for (const frame of document.querySelectorAll('iframe[src]')) {
        if (frame.hasAttribute('srcdoc')) continue;
        const url = URL.parse(frame.getAttribute('src'));
        if (!url || url.protocol !== 'https:' || url.username || url.password || url.href.length > 4096) continue;
        if (!sites.has(url.origin)) sites.set(url.origin, url.href);
        if (sites.size >= 8) break;
      }
      const urls = [...sites.values()], value = JSON.stringify(urls);
      if (value !== last) { last = value; send({protocol, token, topic:'home.embedTargets', urls}, '*'); }
    };
    const schedule = () => { if (!pulse) pulse = requestAnimationFrame(report); };
    addEventListener('DOMContentLoaded', () => {
      new MutationObserver(changes => {
        if (changes.some(change => change.type === 'attributes' ? change.target.localName === 'iframe' :
          [...change.addedNodes, ...change.removedNodes].some(node => node.nodeType === 1 && (node.localName === 'iframe' || node.querySelector('iframe'))))) schedule();
      }).observe(document.body, {subtree:true,childList:true,attributes:true,attributeFilter:['src','srcdoc']});
      schedule();
    }, {once:true});
    // A fast srcdoc can finish parsing before React installs its listener.
    const handshake = event => {
      if (event.source !== parent || event.data?.token !== token || event.data?.topic !== 'host.context') return;
      removeEventListener('message', handshake); last = undefined; schedule();
    };
    addEventListener('message', handshake);
    const follow = event => {
      if (!event.isTrusted || event.defaultPrevented || event.button > 1) return;
      const anchor = event.target.closest?.('a[href]');
      if (!anchor || anchor.hasAttribute('download') || anchor.getAttribute('href').trim().startsWith('#')) return;
      const url = anchor.href;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
      event.preventDefault();
      send({ protocol, token, linkKey, topic: 'home.followLink', url }, '*');
    };
    addEventListener('click', follow);
    addEventListener('auxclick', follow);
  }
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
