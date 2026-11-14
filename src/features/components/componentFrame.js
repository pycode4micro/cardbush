// Runs inside the opaque component iframe. The host checks the sender, token and grants.
(() => {
  const { protocol, token, network } = document.currentScript.dataset;
  // Keep this capability inside the trusted click listener, outside the widget SDK.
  const linkKey = document.currentScript.dataset.linkKey;
  delete document.currentScript.dataset.linkKey;
  if (linkKey) {
    const send = parent.postMessage.bind(parent);
    // A component owns its browser slots and layout. The host admits declared
    // origins and renders each slot as an isolated top-level website document.
    let scheduled = false, last, nextBrowser = 0;
    const identities = new WeakMap(), nodes = new Map(), observed = new WeakSet();
    const resize = new ResizeObserver(() => schedule());
    const identity = node => {
      if (!identities.has(node)) identities.set(node, {id:'browser-'+ ++nextBrowser, revision:0});
      return identities.get(node);
    };
    const report = () => {
      scheduled = false;
      const items = [];
      nodes.clear();
      for (const node of document.querySelectorAll('cardbush-browser[src]')) {
        const url = URL.parse(node.getAttribute('src'));
        if (!url || url.protocol !== 'https:' || url.username || url.password || url.href.length > 4096) continue;
        if (!observed.has(node)) { observed.add(node); resize.observe(node); }
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        if (!node.getClientRects().length || style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
        let left = Math.max(0,box.left), top = Math.max(0,box.top);
        let right = Math.min(document.documentElement.clientWidth,box.right), bottom = Math.min(innerHeight,box.bottom);
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          if (css.visibility !== 'visible' || Number(css.opacity) === 0) { right = left; break; }
          if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) { left = Math.max(left,bounds.left+parent.clientLeft); right = Math.min(right,bounds.left+parent.clientLeft+parent.clientWidth); }
          if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) { top = Math.max(top,bounds.top+parent.clientTop); bottom = Math.min(bottom,bounds.top+parent.clientTop+parent.clientHeight); }
        }
        if (right <= left || bottom <= top) continue;
        const ref = identity(node); nodes.set(ref.id,node);
        items.push({...ref,url:url.href,x:box.x,y:box.y,width:box.width,height:box.height,
          clipX:left,clipY:top,clipWidth:right-left,clipHeight:bottom-top});
        if (items.length >= 8) break;
      }
      const value = JSON.stringify(items);
      if (value !== last) { last = value; send({protocol, token, topic:'home.browserLayout', items}, '*'); }
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(report);
    };
    customElements.define('cardbush-browser', class extends HTMLElement {
      get src() { return this.getAttribute('src') || ''; }
      set src(value) { this.setAttribute('src', value); }
      reload() { identity(this).revision++; schedule(); }
      connectedCallback() { schedule(); }
      disconnectedCallback() { resize.unobserve(this); observed.delete(this); schedule(); }
    });
    addEventListener('DOMContentLoaded', () => {
      new MutationObserver(schedule).observe(document.body, {subtree:true,childList:true,attributes:true,attributeFilter:['src','style','class','hidden']});
      resize.observe(document.documentElement);
      schedule();
    }, {once:true});
    addEventListener('scroll', schedule, true);
    addEventListener('resize', schedule);
    addEventListener('message', event => {
      const message = event.data;
      if (event.source !== parent || message?.protocol !== protocol || message.token !== token) return;
      if (message.topic === 'host.context' || message.topic === 'host.resized') { last = undefined; schedule(); }
      if (message.topic === 'browser.status') {
        const value = message.value, node = nodes.get(value?.id);
        if (node && identity(node).revision === value.revision && URL.parse(node.src)?.href === value.url && ['loaded','failed'].includes(value.state)) {
          node.dispatchEvent(new CustomEvent(value.state === 'loaded' ? 'load' : 'error', {detail:{url:value.url}}));
        }
      }
    });
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
