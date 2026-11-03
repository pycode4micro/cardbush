// Browser-owned UI only. A failed popup must not be interpreted as user denial.
// Fall back to a normal extension tab, retaining the same nonce and sender check.
function openBrowserConsent(page, details, lifetime = 60_000) {
  const token = connectorHex(crypto.getRandomValues(new Uint8Array(24)));
  const url = chrome.runtime.getURL(`${page}#${token}`);
  let resolveResult, markReady, finished = false, windowId;
  const result = new Promise(resolve => { resolveResult = resolve; });
  const ready = new Promise(resolve => { markReady = resolve; });
  const pending = { ...details, token, page, tabId: null, expiresAt: Date.now() + lifetime, ready, result,
    finish(value = false) {
      if (finished) return;
      finished = true; pending.closed = true; clearTimeout(timer); markReady();
      chrome.windows.onRemoved.removeListener(windowRemoved);
      chrome.tabs.onRemoved.removeListener(tabRemoved);
      if (Number.isInteger(pending.tabId)) void chrome.tabs.remove(pending.tabId).catch(() => {});
      else if (Number.isInteger(windowId)) void chrome.windows.remove(windowId).catch(() => {});
      resolveResult(value);
    },
  };
  const tabRemoved = id => { if (id === pending.tabId) pending.finish(); };
  const windowRemoved = id => { if (id === windowId) pending.finish(); };
  const timer = setTimeout(() => pending.finish(), lifetime);
  chrome.tabs.onRemoved.addListener(tabRemoved);
  chrome.windows.onRemoved.addListener(windowRemoved);
  void (async () => {
    let tab;
    try {
      const created = await chrome.windows.create({ url, type: 'popup', width: 480, height: 520, focused: true });
      windowId = created?.id;
      tab = created?.tabs?.find(candidate => Number.isInteger(candidate.id));
      if (!tab && Number.isInteger(windowId)) tab = (await chrome.tabs.query({ windowId }))[0];
    } catch { /* Edge/Chrome may refuse a popup. Use an ordinary extension tab. */ }
    if (!finished && !Number.isInteger(tab?.id)) {
      // Do not leave an empty or unbound confirmation window behind.
      const emptyWindow = windowId; windowId = undefined;
      if (Number.isInteger(emptyWindow)) await chrome.windows.remove(emptyWindow).catch(() => {});
      tab = await chrome.tabs.create({ url, active: true });
      if (Number.isInteger(tab?.windowId)) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    if (finished) {
      if (Number.isInteger(tab?.id)) await chrome.tabs.remove(tab.id).catch(() => {});
      return;
    }
    if (!Number.isInteger(tab?.id)) { pending.finish(); return; }
    pending.tabId = tab.id;
    markReady();
  })().catch(() => pending.finish());
  return pending;
}

async function isBrowserConsentSender(pending, message, sender) {
  if (!pending || message.token !== pending.token || sender?.id !== chrome.runtime.id
    || sender.url?.split('#')[0] !== chrome.runtime.getURL(pending.page)) return false;
  await pending.ready;
  return !pending.closed && Number.isInteger(pending.tabId) && sender.tab?.id === pending.tabId && Date.now() < pending.expiresAt;
}
