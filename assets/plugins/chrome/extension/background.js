importScripts('build-info.js', 'downloads.js', 'connector-transport.js');
// Capture the loaded worker's build. getManifest() alone cannot identify a
// stale service worker after the unpacked extension files change on disk.
const runtimeBuild = globalThis.CARDBUSH_CONNECTOR_BUILD;
const PAIRING_KEY = 'cardbushConnectorPairingV2';
const AUTOMATIC_IDENTITY_KEY = 'cardbushLocalBrowserIdentity';
const CONNECTOR_PROTOCOL = 'cardbush.chrome_connector.v1';
const DEBUGGER_PROTOCOL_VERSION = '1.3';
const CONTROL_IDLE_TIMEOUT_MS = 60_000;
// Finish before the bridge's 30 s deadline, so the caller receives a specific cause.
const SCREENSHOT_TIMEOUT_MS = 25_000;
const RECONNECT_ALARM = 'cardbush-native-reconnect';
const RECONNECT_DELAY_MINUTES = 0.5;
const MAX_CONNECTION_ATTEMPTS = 3;
const RECONNECT_STATE_KEY = 'cardbushNativeReconnect';
const CONNECTOR_ENABLED_KEY = 'cardbushConnectorEnabled';
let connectorEnabled = false;
let connectionEpoch = 0;
let localConnectionRequestEpoch = null;
let localConnectionRequested = false;
let connectorPreferenceQueue = Promise.resolve();
let connectionCleanup = Promise.resolve();
const MANAGED_SCOPES_STORAGE_KEY = 'cardbushManagedScopes';
const ACTIVE_SCOPE_STORAGE_KEY = 'cardbushActiveScope';
const SESSION_GRANTS_STORAGE_KEY = 'cardbushSessionGrants';
const SCOPE_LEASES_STORAGE_KEY = 'cardbushScopeLeases';
const PENDING_AUTHORIZATIONS_STORAGE_KEY = 'cardbushPendingAuthorizations';
const AUTHORIZATION_LEASE_TTL_MS = 5 * 60_000;
const GROUP_COLOR = 'cyan';
const GROUP_TITLE_PREFIX = 'CardBush · ';

let nativePort = null;
let nativeReady = false;
let connectingEpoch = null;
let pairingController = null;
let browserConnectionConsent = null;
let lastError = '';
let connectionFailures = 0;
let fastReconnectTimer = null;
let reconnectPaused = false;
let reconnectWaiting = false;
let hasReconnectPairing = false;
let pairingRequired = false;
let activeScope = null;
const attachedTabs = new Map();
const attachmentReady = new Map();
const viewportTabs = new Set();
const downloadManager = createDownloadManager(chrome);
const pendingScreenshots = new Map();
const sessionGrants = new Map();
const scopeLeases = new Map();
const pendingAuthorizations = new Map();
const managedScopes = new Map();
const tabReferenceKeys = new Map();
let tabReferenceKeysDirty = false;
const TAB_REFERENCE_KEYS = 'cardbushTabReferenceKeys';
const controlIdleTimers = new Map();
const groupCreations = new Map();
const managedScopesReady = restoreManagedState();
const reconnectReady = restoreReconnectState();

void reconnectReady.then(() => connectNative());
chrome.runtime.onInstalled.addListener(() => { void reconnectReady.then(() => connectNative()); });
chrome.runtime.onStartup.addListener(() => { void reconnectReady.then(() => connectNative()); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void reconnectReady.then(() => {
    reconnectWaiting = false;
    return connectNative();
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (['connection_state', 'confirm_connection'].includes(message?.action)) {
    void (async () => {
      const pending = browserConnectionConsent;
      if (!pending || message.token !== pending.token || sender.id !== chrome.runtime.id
        || sender.url?.split('#')[0] !== chrome.runtime.getURL('connection.html')) return { ok: false };
      await pending.ready;
      if (browserConnectionConsent !== pending || !Number.isInteger(pending.tabId)
        || sender.tab?.id !== pending.tabId || Date.now() >= pending.expiresAt) return { ok: false };
      if (message.action === 'connection_state') return { ok: true, browser: pending.browser, expiresAt: pending.expiresAt };
      pending.finish(message.allow === true);
      return { ok: true };
    })().then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  void handlePopupMessage(message).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: normalizedError(error) });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void managedScopesReady.then(async () => {
    if (tabReferenceKeys.delete(tabId)) { tabReferenceKeysDirty = true; await persistTabReferenceKeys(); }
  });
  viewportTabs.delete(tabId);
  interruptScreenshot(tabId);
  attachedTabs.delete(tabId);
  void managedScopesReady.then(async () => {
    const grantChanged = sessionGrants.delete(tabId);
    const pendingChanged = forgetPendingAuthorizations({ tabId });
    if (grantChanged || pendingChanged) await persistSessionState();
    await publishStatus();
  });
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) viewportTabs.delete(source.tabId);
  if (source.tabId != null) interruptScreenshot(source.tabId);
  if (source.tabId != null) attachedTabs.delete(source.tabId);
  void publishStatus();
});

chrome.tabGroups.onRemoved.addListener((group) => {
  void managedScopesReady.then(async () => {
    if (forgetManagedGroup(group.id)) await persistManagedScopes();
  });
});

async function connectNative(manual = false, requestLocal) {
  if (manual) {
    await reconnectReady;
    const renewLocalIdentity = requestLocal === true || (localConnectionRequested && !connectorEnabled);
    const epoch = ++connectionEpoch;
    pairingController?.abort();
    await persistConnectorPreference(true, async () => {
      if (epoch === connectionEpoch && (pairingRequired || renewLocalIdentity)) await chrome.storage.local.remove(AUTOMATIC_IDENTITY_KEY);
    });
    if (epoch !== connectionEpoch) return;
    connectorEnabled = true;
    // Connect retries the user's current target. A failed local enrollment
    // must not silently fall back to an unrelated saved/remote pairing.
    if (requestLocal !== undefined) localConnectionRequested = requestLocal;
    connectionFailures = 0;
    reconnectPaused = false;
    reconnectWaiting = false;
    pairingRequired = false;
    void persistReconnectState();
  }
  if (!connectorEnabled || pairingRequired || reconnectPaused || reconnectWaiting) return;
  if (nativePort || connectingEpoch === connectionEpoch) return;
  const epoch = connectionEpoch;
  connectingEpoch = epoch;
  if (localConnectionRequested) localConnectionRequestEpoch = epoch;
  lastError = '';
  clearTimeout(fastReconnectTimer); fastReconnectTimer = null;
  try {
    await chrome.alarms.clear(RECONNECT_ALARM);
    await connectionCleanup;
    const saved = await chrome.storage.local.get([PAIRING_KEY]);
    if (epoch !== connectionEpoch || !connectorEnabled || nativePort || pairingRequired) return;
    let pairing;
    if (saved[PAIRING_KEY] && !localConnectionRequested) {
      try { pairing = parseConnectorPairing(saved[PAIRING_KEY]); hasReconnectPairing = true; }
      catch (error) { pairingRequired = true; throw error; }
    }
    else pairing = await automaticConnectorPairing(epoch);
    if (epoch !== connectionEpoch || !connectorEnabled || nativePort) return;
    void chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: RECONNECT_DELAY_MINUTES });
    const port = createConnectorPort(pairing);
    nativePort = port;
    nativeReady = false;
    lastError = '';
    let connectionError = '';
    const handshakeTimer = setTimeout(() => {
      if (nativePort !== port || nativeReady) return;
      lastError = 'CardBush 连接超时，正在等待本机连接器恢复。';
      nativePort = null;
      port.disconnect();
      suspendDisconnectedControl();
      scheduleReconnect();
    }, 12_000);
    port.onMessage.addListener((message) => {
      if (nativePort !== port) return;
      if (message?.type === 'connector_ready' && message.protocol === CONNECTOR_PROTOCOL) {
        clearTimeout(handshakeTimer);
        nativeReady = true;
        lastError = '';
        connectionFailures = 0;
        reconnectPaused = false;
        reconnectWaiting = false;
        void chrome.alarms.clear(RECONNECT_ALARM);
        pairingRequired = false;
        void persistConnectorEndpoint(pairing, port, epoch).catch(() => {
          if (nativePort === port) lastError = '连接已恢复，但新地址未能保存；下次连接会自动重新查找。';
        });
        void persistReconnectState();
        void publishStatus();
        return;
      }
      if (message?.type === 'connector_error') {
        if (nativeReady && message.code === 'cardbush_command_too_large') {
          // A rejected command does not close the authenticated native bridge.
          lastError = String(message.message || message.code);
          void publishStatus();
          return;
        }
        clearTimeout(handshakeTimer);
        nativeReady = false;
        connectionError = String(message.message || message.code || 'Connector error');
        lastError = connectionError;
        return;
      }
      if (!nativeReady) return;
      if (message?.type === 'control' && message.method === 'connector.disable') {
        void disableConnector(message.reason === 'pairing_removed').catch(error => { lastError = errorMessage(error); });
        return;
      }
      if (message?.type === 'control' && message.method === 'debugger.detachAll') {
        void releaseAll();
        return;
      }
      if (message?.type === 'control' && message.method === 'debugger.suspendAll') {
        void suspendAll();
        return;
      }
      if (message?.type === 'request') void handleNativeRequest(message);
    });
    port.onDisconnect.addListener(() => {
      const disconnectError = chrome.runtime.lastError?.message;
      clearTimeout(handshakeTimer);
      if (nativePort !== port) return;
      lastError = connectionError || disconnectError || 'CardBush 暂时离线，等待自动重连。';
      nativePort = null;
      nativeReady = false;
      suspendDisconnectedControl();
      scheduleReconnect();
    });
  } catch (error) {
    if (epoch !== connectionEpoch || nativePort) return;
    lastError = errorMessage(error);
    nativePort = null;
    nativeReady = false;
    scheduleReconnect();
  } finally {
    if (connectingEpoch === epoch) connectingEpoch = null;
    if (localConnectionRequestEpoch === epoch) localConnectionRequestEpoch = null;
  }
}

async function automaticConnectorPairing(epoch) {
  const saved = await chrome.storage.local.get([AUTOMATIC_IDENTITY_KEY]);
  if (epoch !== connectionEpoch || !connectorEnabled) throw new Error('连接申请已取消。');
  let identity = saved[AUTOMATIC_IDENTITY_KEY];
  if (!identity) {
    identity = { id: connectorHex(crypto.getRandomValues(new Uint8Array(16))) };
    const operation = connectorPreferenceQueue.catch(() => {}).then(async () => {
      if (epoch !== connectionEpoch || !connectorEnabled) throw new Error('连接申请已取消。');
      await chrome.storage.local.set({ [AUTOMATIC_IDENTITY_KEY]: identity });
    });
    connectorPreferenceQueue = operation; await operation;
  }
  if (epoch !== connectionEpoch || !connectorEnabled) throw new Error('连接申请已取消。');
  const controller = new AbortController(); pairingController = controller;
  let result;
  try {
    result = await requestConnectorPairing(identity, { signal: controller.signal,
      confirm: signal => confirmLocalBrowserConnection(signal), onPrepared: async (code, confirmed = false) => {
      const operation = connectorPreferenceQueue.catch(() => {}).then(async () => {
        if (epoch !== connectionEpoch || !connectorEnabled) throw new Error('连接申请已取消。');
        identity = { id: identity.id, pending: code, confirmed };
        await chrome.storage.local.set({ [AUTOMATIC_IDENTITY_KEY]: identity });
      });
      connectorPreferenceQueue = operation; await operation;
    } });
  } catch (error) {
    if (['connection_denied', 'connection_revoked', 'identity_conflict'].includes(error.code) && epoch === connectionEpoch) {
      pairingRequired = true; connectorEnabled = false; await persistConnectorPreference(false);
    }
    throw error;
  } finally { if (pairingController === controller) pairingController = null; }
  const pairing = parseConnectorPairing(result?.code);
  // A late approval cannot undo an explicit disconnect or manual pairing.
  const operation = connectorPreferenceQueue.catch(() => {}).then(async () => {
    if (epoch === connectionEpoch && connectorEnabled) {
      await chrome.storage.local.set({ [PAIRING_KEY]: result.code });
      hasReconnectPairing = true;
      localConnectionRequested = false;
    }
  });
  connectorPreferenceQueue = operation;
  await operation;
  return pairing;
}

function confirmLocalBrowserConnection(signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    browserConnectionConsent?.finish(false);
    const token = connectorHex(crypto.getRandomValues(new Uint8Array(24)));
    let markReady;
    const ready = new Promise(resolveReady => { markReady = resolveReady; });
    const expiresAt = Date.now() + 60_000;
    let windowId, finished = false;
    const removed = id => { if (id === windowId) finish(false); };
    const cancel = () => finish(false);
    const timer = setTimeout(cancel, 60_000);
    const finish = allowed => {
      if (finished) return; finished = true; markReady(); clearTimeout(timer); signal.removeEventListener('abort', cancel);
      chrome.windows.onRemoved.removeListener(removed);
      if (browserConnectionConsent?.token === token) browserConnectionConsent = null;
      if (windowId !== undefined) void chrome.windows.remove(windowId).catch(() => {});
      resolve(allowed);
    };
    browserConnectionConsent = { token, tabId: null, finish, ready, expiresAt, browser: connectorBrowser() };
    signal.addEventListener('abort', cancel, { once: true });
    chrome.windows.onRemoved.addListener(removed);
    void chrome.windows.create({ url: chrome.runtime.getURL(`connection.html#${token}`), type: 'popup', width: 480, height: 470, focused: true })
      .then(async window => {
        windowId = window.id;
        if (finished) { if (windowId !== undefined) await chrome.windows.remove(windowId); return; }
        const tabs = window.tabs ?? await chrome.tabs.query({ windowId });
        if (!Number.isInteger(tabs[0]?.id)) { cancel(); return; }
        if (browserConnectionConsent?.token === token) browserConnectionConsent.tabId = tabs[0]?.id;
        markReady();
      }).catch(cancel);
  });
}

function scheduleReconnect() {
  clearTimeout(fastReconnectTimer); fastReconnectTimer = null;
  if (!connectorEnabled || pairingRequired) {
    void persistReconnectState();
    void chrome.alarms.clear(RECONNECT_ALARM); return;
  }
  connectionFailures = Math.min(connectionFailures + 1, MAX_CONNECTION_ATTEMPTS);
  // An outage cannot revoke consent. Only enrollment stops after the fast
  // budget; saved credentials keep one bounded, authenticated probe per alarm.
  // This never falls back to enrollment or replays browser commands.
  const exhausted = connectionFailures >= MAX_CONNECTION_ATTEMPTS;
  reconnectWaiting = exhausted && hasReconnectPairing && !localConnectionRequested;
  reconnectPaused = exhausted && !reconnectWaiting;
  void persistReconnectState();
  if (reconnectPaused) { void chrome.alarms.clear(RECONNECT_ALARM); return; }
  void chrome.alarms.create(RECONNECT_ALARM, {
    delayInMinutes: RECONNECT_DELAY_MINUTES,
  });
  if (reconnectWaiting) return;
  // Timers make a quick app restart responsive while the worker is alive. The
  // persisted alarm remains armed if Chrome suspends the worker or a timer.
  const delayMs = 1000 * 2 ** (connectionFailures - 1);
  fastReconnectTimer = setTimeout(() => { fastReconnectTimer = null; void connectNative(); }, delayMs);
}

function suspendDisconnectedControl() {
  // Release active debugger access before a new connection can issue commands,
  // while preserving grants for the same isolated tabs within this browser run.
  connectionCleanup = connectionCleanup.catch(() => {}).then(async () => {
    await managedScopesReady;
    await suspendAll();
  }).catch(error => { lastError = errorMessage(error); });
}

async function restoreReconnectState() {
  const preference = await chrome.storage.local.get([CONNECTOR_ENABLED_KEY, PAIRING_KEY, RECONNECT_STATE_KEY]);
  const saved = await chrome.storage.session.get([RECONNECT_STATE_KEY]);
  // The user's explicit enable choice survives both browser and worker restarts.
  // Exhausted enrollment remains stopped. An already authorized target instead
  // resumes background recovery, including state saved by older extensions.
  connectorEnabled = preference[CONNECTOR_ENABLED_KEY] !== false;
  pairingRequired = !connectorEnabled && !preference[PAIRING_KEY];
  const state = preference[RECONNECT_STATE_KEY] ?? saved[RECONNECT_STATE_KEY];
  localConnectionRequested = state?.localConnectionRequested === true;
  try { hasReconnectPairing = Boolean(preference[PAIRING_KEY] && parseConnectorPairing(preference[PAIRING_KEY])); }
  catch { hasReconnectPairing = false; }
  if (!connectorEnabled) {
    if (typeof state?.lastError === 'string') lastError = state.lastError.slice(0, 1600);
    await chrome.alarms.clear(RECONNECT_ALARM); return;
  }
  if (!state || !Number.isInteger(state.failures) || state.failures < 0) return;
  connectionFailures = Math.min(MAX_CONNECTION_ATTEMPTS, state.failures);
  const exhausted = connectionFailures >= MAX_CONNECTION_ATTEMPTS;
  reconnectWaiting = exhausted && hasReconnectPairing && !localConnectionRequested;
  reconnectPaused = exhausted && !reconnectWaiting;
  if (typeof state.lastError === 'string') lastError = state.lastError.slice(0, 1600);
  if (reconnectPaused) await chrome.alarms.clear(RECONNECT_ALARM);
  else if (reconnectWaiting) await chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: RECONNECT_DELAY_MINUTES });
}

async function disableConnector(forgetPairing = false) {
  await reconnectReady;
  connectorEnabled = false;
  reconnectWaiting = false;
  connectionEpoch++;
  pairingController?.abort();
  clearTimeout(fastReconnectTimer); fastReconnectTimer = null;
  nativeReady = false;
  const port = nativePort;
  nativePort = null;
  await persistConnectorPreference(false, async () => {
    if (forgetPairing) {
      await chrome.storage.local.set({ [PAIRING_KEY]: '' });
      hasReconnectPairing = false;
      pairingRequired = true;
      lastError = '此浏览器的连接已被移除。需要恢复本机连接时，请点击「连接 CardBush」重新申请；手动连接或远程 Agent 配对请使用目标 Agent 提供的配对码。';
    }
    await chrome.alarms.clear(RECONNECT_ALARM);
    port?.disconnect();
    await connectionCleanup.catch(() => {});
    await managedScopesReady;
    await releaseAll();
  });
}

function persistConnectorPreference(enabled, cleanup) {
  // Preserve click order across asynchronous storage writes and release the old
  // debugger sessions before a later explicit Connect can open a new port.
  const operation = connectorPreferenceQueue.catch(() => {}).then(async () => {
    try {
      await chrome.storage.local.set({ [CONNECTOR_ENABLED_KEY]: enabled });
      await chrome.storage.session.set({ [CONNECTOR_ENABLED_KEY]: enabled });
    } finally { await cleanup?.(); }
  });
  connectorPreferenceQueue = operation;
  return operation;
}

function persistConnectorEndpoint(pairing, port, epoch) {
  const endpoint = port.endpointPort;
  if (!Number.isInteger(endpoint) || endpoint < 1024 || endpoint > 65535 || endpoint === pairing.port) return Promise.resolve();
  // Serialize with disable/remove. A late recovery must never resurrect a
  // removed pairing or overwrite the credentials of a newly paired profile.
  const operation = connectorPreferenceQueue.catch(() => {}).then(async () => {
    const current = () => connectorEnabled && epoch === connectionEpoch && nativePort === port && nativeReady;
    if (!current()) return;
    const saved = await chrome.storage.local.get([PAIRING_KEY]);
    let existing;
    try { existing = parseConnectorPairing(saved[PAIRING_KEY]); } catch { return; }
    if (!current() || existing.id !== pairing.id || existing.secret !== pairing.secret) return;
    await chrome.storage.local.set({ [PAIRING_KEY]: `CB2.${endpoint}.${pairing.id}.${pairing.secret}` });
  });
  connectorPreferenceQueue = operation;
  return operation;
}

function persistReconnectState() {
  const epoch = connectionEpoch;
  const state = {
    failures: connectionFailures, lastError: lastError.slice(0, 1600), localConnectionRequested,
  };
  const operation = connectorPreferenceQueue.catch(() => {}).then(async () => {
    if (epoch === connectionEpoch) await chrome.storage.local.set({ [RECONNECT_STATE_KEY]: state });
  });
  connectorPreferenceQueue = operation;
  return operation;
}

async function handleNativeRequest(message) {
  if (!connectorEnabled || !nativeReady) return;
  const epoch = connectionEpoch;
  const port = nativePort;
  const progress = (stage) => {
    try { port?.postMessage({ type: 'progress', id: message.id, clientId: message.clientId, stage }); } catch { /* Disconnected. */ }
  };
  const response = {
    type: 'response',
    id: message.id,
    clientId: message.clientId,
  };
  try {
    progress('extension_received');
    response.result = await dispatch(String(message.method || ''), message.params || {}, progress);
    await persistTabReferenceKeys();
  } catch (error) {
    response.error = normalizedError(error);
  }
  if (epoch !== connectionEpoch || port !== nativePort || !connectorEnabled) { await releaseAll(); return; }
  try { port?.postMessage(response); } catch { /* Do not send a previous connection's response to a new peer. */ }
  await publishStatus();
}

async function dispatch(method, params, progress = () => {}) {
  await managedScopesReady;
  // User clicks only reveal a tab. They do not switch control scopes, renew
  // permissions, navigate a live page or attach a debugger.
  if (method === 'tabs.reveal' || method === 'tabs.reopen') {
    let tab;
    if (method === 'tabs.reveal') {
      const id = requiredTabId(params.tabId);
      if (!params.expectedTargetKey || tabReferenceKeys.get(id) !== params.expectedTargetKey) throw Object.assign(new Error('The referenced tab was closed or belongs to an earlier browser session.'), { code: 'browser_tab_missing' });
      try { tab = await chrome.tabs.get(id); }
      catch { throw Object.assign(new Error('The referenced tab is closed.'), { code: 'browser_tab_missing' }); }
      if (tab.groupId >= 0) await chrome.tabGroups.update(tab.groupId, { collapsed: false });
      tab = await chrome.tabs.update(id, { active: true });
    } else tab = await chrome.tabs.create({ url: safeNavigationUrl(params.url), active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    const result = publicTab(tab);
    await persistTabReferenceKeys();
    return result;
  }
  const scope = requiredScope(params);
  if (method === 'debugger.suspendScope') {
    // Turn completion must not activate/rename a group or renew a page grant.
    if (!managedScopes.has(scope.id)) return { suspended: false, scopeId: scope.id };
    await suspendScope(scope.id);
    return { suspended: true, scopeId: scope.id };
  }
  await activateScope(scope);
  progress('scope_ready');

  if (method === 'connector.status') return await connectorState(scope);
  if (method === 'downloads.start') {
    await requireTabAccess(scope, requiredTabId(params.tabId));
    return downloadManager.start(scope, params);
  }
  if (method === 'downloads.status') return downloadManager.status(scope, params);
  if (method === 'downloads.cancel') return downloadManager.cancel(scope, params);
  if (method === 'tabs.list') return await listScopeTabs(scope);
  if (method === 'tabs.activate') {
    const tabId = requiredTabId(params.tabId);
    let tab = await requireManagedTab(scope, tabId);
    // Selecting an automation target must not select the user's visible tab.
    if (params.bringToFront === true) {
      if (tab.groupId >= 0) await chrome.tabGroups.update(tab.groupId, { collapsed: false });
      tab = await chrome.tabs.update(tabId, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    }
    return publicTab(tab);
  }
  if (method === 'tabs.create') {
    const targetUrl = safeNavigationUrl(params.url);
    const foreground = params.background === false;
    const tab = await chrome.tabs.create({ url: targetUrl, active: foreground });
    try {
      await addTabToScope(scope, tab);
    } catch (error) {
      if (tab.id != null) {
        try { await chrome.tabs.remove(tab.id); } catch { /* Best-effort rollback. */ }
      }
      throw error;
    }
    if (tab.id != null) {
      setSessionGrant(tab.id, scope.id, originForUrl(targetUrl), 'created');
      await persistSessionState();
    }
    if (foreground) {
      const created = await chrome.tabs.get(tab.id);
      if (created.groupId >= 0) await chrome.tabGroups.update(created.groupId, { collapsed: false });
      if (created.windowId != null) await chrome.windows.update(created.windowId, { focused: true });
    }
    return publicTab(await chrome.tabs.get(tab.id));
  }
  if (method === 'tabs.close') {
    const tabId = requiredTabId(params.tabId);
    await requireManagedTab(scope, tabId);
    await detachTab(tabId);
    await chrome.tabs.remove(tabId);
    return { closed: true, tabId };
  }
  if (method === 'tabs.navigate') {
    const tabId = requiredTabId(params.tabId);
    const action = String(params.action || 'url');
    if (action === 'back') {
      await requireTabAccess(scope, tabId);
      await chrome.tabs.goBack(tabId);
    } else if (action === 'forward') {
      await requireTabAccess(scope, tabId);
      await chrome.tabs.goForward(tabId);
    } else if (action === 'reload') {
      await requireTabAccess(scope, tabId);
      await chrome.tabs.reload(tabId, { bypassCache: params.ignoreCache === true });
    } else {
      const targetUrl = safeNavigationUrl(params.url);
      await requireTabAccess(scope, tabId, originForUrl(targetUrl));
      await chrome.tabs.update(tabId, { url: targetUrl });
    }
    return publicTab(await chrome.tabs.get(tabId));
  }
  if (method === 'debugger.command') {
    const tabId = requiredTabId(params.tabId);
    progress('checking_access');
    await requireTabAccess(scope, tabId);
    progress('attaching_debugger');
    await ensureAttached(scope, tabId);
    progress('debugger_ready');
    touchControlTimer(scope.id);
    const command = String(params.command || '');
    progress('command_pending');
    const run = () => chrome.debugger.sendCommand(
      { tabId },
      command,
      params.commandParams && typeof params.commandParams === 'object'
        ? params.commandParams
        : {},
    );
    const result = command === 'Page.captureScreenshot' ? await captureScreenshot(tabId, run) : await run();
    if (command === 'Emulation.setDeviceMetricsOverride') viewportTabs.add(tabId);
    if (command === 'Emulation.clearDeviceMetricsOverride') viewportTabs.delete(tabId);
    progress('command_finished');
    if (attachedTabs.get(tabId) === scope.id) touchControlTimer(scope.id);
    return result || {};
  }
  if (method === 'debugger.detach') {
    const tabId = requiredTabId(params.tabId);
    await requireManagedTab(scope, tabId);
    await detachTab(tabId);
    return { detached: true, tabId };
  }
  if (method === 'debugger.detachScope') {
    await releaseScope(scope.id);
    return { detached: true, scopeId: scope.id };
  }
  throw connectorError('unsupported_method', `Unsupported connector method: ${method}`);
}

async function handlePopupMessage(message) {
  await managedScopesReady;
  await reconnectReady;
  const action = String(message?.action || 'status');
  if (action === 'status') {
    // Opening the popup may retry immediately; passive status polling does not
    // bypass backoff or re-enable an explicitly disabled extension.
    if (message?.reconnect === true) void connectNative().catch(error => { lastError = errorMessage(error); });
    return { ok: true, ...(await popupState(message?.scopeId)) };
  }
  if (action === 'pair') {
    const code = String(message?.code || '').trim();
    parseConnectorPairing(code);
    await disableConnector();
    await chrome.storage.local.set({ [PAIRING_KEY]: code });
    await connectNative(true, false);
    return { ok: true, ...(await popupState()) };
  }
  if (action === 'reconnect') {
    // Keep popup status and Disable usable while the confirmation is open.
    void connectNative(true).catch(error => { lastError = errorMessage(error); });
    return { ok: true, ...(await popupState(message?.scopeId)) };
  }
  if (action === 'request_local_connection') {
    if (nativeReady) throw connectorError('browser_already_connected', '当前连接正常，无需重新申请。');
    // Only this explicit user action may replace the target of a saved pairing.
    // Keep its credential until browser consent and the broker commit succeed.
    // Background retries must never reset identity or silently switch hosts.
    await disableConnector();
    void connectNative(true, true).catch(error => { lastError = errorMessage(error); });
    return { ok: true, ...(await popupState(message?.scopeId)) };
  }
  if (action === 'disable_connector') {
    await disableConnector();
    return { ok: true, ...(await popupState()) };
  }
  if (action === 'disconnect') {
    const scope = await popupAuthorizationScope(message?.scopeId);
    if (scope) await releaseScope(scope.id);
    else await releaseAll();
    return { ok: true, ...(await popupState()) };
  }
  if (action === 'revoke') {
    await chrome.storage.local.set({ allowAllSites: false, allowedOrigins: [] });
    await releaseAll();
    return { ok: true, ...(await popupState()) };
  }
  if (!['allow_once', 'allow_site', 'allow_all'].includes(action)) {
    throw connectorError('unsupported_popup_action', `Unsupported action: ${action}`);
  }
  if (!nativePort || !nativeReady) {
    throw connectorError(
      'cardbush_not_connected',
      'Open CardBush and start a browser task before adding an existing browser tab.',
    );
  }

  const [sourceTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (sourceTab?.id == null) throw connectorError('active_tab_missing', 'No active browser tab is available.');
  const origin = originForTab(sourceTab);
  if (!origin) throw connectorError('unsupported_page', 'This browser page cannot be controlled.');
  const scope = await popupAuthorizationScope(message?.scopeId, sourceTab);
  if (!scope) {
    throw connectorError(
      'browser_scope_missing',
      'Start a browser task in CardBush, then select its session before adding an existing browser tab.',
    );
  }

  const managedTab = await copyTabIntoScope(scope, sourceTab);
  if (managedTab.id == null) throw connectorError('active_tab_missing', 'The copied browser tab has no id.');
  if (action === 'allow_once') {
    setSessionGrant(managedTab.id, scope.id, origin, 'copied');
  } else if (action === 'allow_site') {
    const stored = await chrome.storage.local.get(['allowedOrigins']);
    const origins = new Set(Array.isArray(stored.allowedOrigins) ? stored.allowedOrigins : []);
    origins.add(origin);
    await chrome.storage.local.set({ allowedOrigins: [...origins] });
  } else {
    await chrome.storage.local.set({ allowAllSites: true });
  }

  forgetPendingAuthorizations({ scopeId: scope.id, origin });
  await activateScope(scope);
  await persistSessionState();

  connectNative();
  await publishStatus();
  return { ok: true, copiedTabId: managedTab.id, ...(await popupState(scope.id)) };
}

async function copyTabIntoScope(scope, sourceTab) {
  if (await isTabManaged(scope, sourceTab)) return sourceTab;
  const copied = await chrome.tabs.duplicate(sourceTab.id);
  if (copied?.id == null) throw connectorError('tab_copy_failed', 'The browser did not return the copied tab.');
  try {
    const groupId = await addTabToScope(scope, copied);
    await chrome.tabGroups.update(groupId, { collapsed: false });
    await chrome.tabs.update(copied.id, { active: true });
    if (copied.windowId != null) await chrome.windows.update(copied.windowId, { focused: true });
    return await chrome.tabs.get(copied.id);
  } catch (error) {
    try { await chrome.tabs.remove(copied.id); } catch { /* Best-effort rollback. */ }
    throw error;
  }
}

async function listScopeTabs(scope) {
  const groupIds = managedGroupIds(scope);
  if (groupIds.size === 0) return [];
  const tabs = await chrome.tabs.query({});
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs
    .filter((tab) => tab.id != null && groupIds.has(tab.groupId))
    .map((tab) => ({
      ...publicTab(tab),
      active: tab.id === focused?.id,
    }));
}

async function requireManagedTab(scope, tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!await isTabManaged(scope, tab)) {
    throw connectorError(
      'unmanaged_tab',
      'This tab is outside the current CardBush session group and cannot be controlled.',
      { tabId, scopeId: scope.id },
    );
  }
  return tab;
}

async function isTabManaged(scope, tab) {
  return tab?.id != null && Number.isSafeInteger(tab.groupId) && managedGroupIds(scope).has(tab.groupId);
}

async function requireTabAccess(scope, tabId, requestedOrigin = '') {
  const tab = await requireManagedTab(scope, tabId);
  const origin = requestedOrigin || originForTab(tab);
  const grant = sessionGrants.get(tabId);
  if (grant?.scopeId === scope.id) {
    if (!origin || grant.origins.has(origin)) return tab;
    if (grant.source === 'created' && grant.origins.size === 0) {
      grant.origins.add(origin);
      await persistSessionState();
      return tab;
    }
  }
  if (!origin) {
    throw connectorError('unsupported_page', 'The browser does not permit extensions to debug this page.');
  }
  const stored = await chrome.storage.local.get(['allowedOrigins', 'allowAllSites']);
  const allowedOrigins = Array.isArray(stored.allowedOrigins) ? stored.allowedOrigins : [];
  if (stored.allowAllSites !== true && !allowedOrigins.includes(origin)) {
    await rememberPendingAuthorization(scope, tab, origin);
    throw connectorError(
      'site_permission_required',
      `Open the CardBush Browser Use in the selected browser and allow access to ${origin}.`,
      { tabId, origin, scopeId: scope.id },
    );
  }
  return tab;
}

async function ensureAttached(scope, tabId) {
  if (attachmentReady.has(tabId)) await attachmentReady.get(tabId);
  const attachedScopeId = attachedTabs.get(tabId);
  if (attachedScopeId === scope.id) return;
  if (attachedScopeId) await detachTab(tabId);
  const ready = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
      attachedTabs.set(tabId, scope.id);
      // Keep the controlled renderer live without activating its tab/window.
      // Chrome clears this page-scoped override when the debugger detaches.
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (error) {
      if (attachedTabs.get(tabId) === scope.id) await detachTab(tabId);
      throw connectorError('debugger_attach_failed', errorMessage(error), { tabId });
    }
  })();
  attachmentReady.set(tabId, ready);
  try { await ready; } finally { if (attachmentReady.get(tabId) === ready) attachmentReady.delete(tabId); }
  await publishStatus();
}

async function detachTab(tabId) {
  interruptScreenshot(tabId);
  if (viewportTabs.delete(tabId) && attachedTabs.has(tabId)) {
    // A renderer may stop responding during capture/navigation. Detach must not
    // wait for that renderer before releasing the debugger and reconnecting.
    void chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
  }
  if (!attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Chrome may already have detached the tab during navigation or close.
  }
  attachedTabs.delete(tabId);
}

async function captureScreenshot(tabId, run) {
  const previous = pendingScreenshots.get(tabId);
  if (previous) throw connectorError('screenshot_in_progress',
    'The previous screenshot is still pending in the browser. Repeating it will not start another capture. Release the browser before reconnecting, or use another preview route.',
    { tabId, pendingMs: Date.now() - previous.startedAt });
  let cancel;
  let timer;
  const interrupted = new Promise((_, reject) => { cancel = () => reject(connectorError('screenshot_interrupted', 'The browser detached before the screenshot completed.', { tabId })); });
  const pending = { startedAt: Date.now(), cancel };
  pendingScreenshots.set(tabId, pending);
  const completion = Promise.resolve().then(run).finally(() => {
    // A timed-out command can finish after a later debugger attachment.
    if (pendingScreenshots.get(tabId) === pending) pendingScreenshots.delete(tabId);
  });
  try {
    return await Promise.race([completion, interrupted, new Promise((_, reject) => {
      timer = setTimeout(() => reject(connectorError('screenshot_timeout',
        'The browser did not finish the screenshot within 25 seconds. The capture may still be pending; release the browser before reconnecting, or use another preview route.',
        { tabId, timeoutMs: SCREENSHOT_TIMEOUT_MS })), SCREENSHOT_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

function interruptScreenshot(tabId) {
  pendingScreenshots.get(tabId)?.cancel();
  pendingScreenshots.delete(tabId);
}

async function suspendScope(scopeId) {
  clearControlTimer(scopeId);
  const tabIds = [...attachedTabs]
    .filter(([, attachedScopeId]) => attachedScopeId === scopeId)
    .map(([tabId]) => tabId);
  await Promise.all(tabIds.map(detachTab));
  await collapseScopeGroups(scopeId);
  await publishStatus(false);
}

async function releaseScope(scopeId) {
  await suspendScope(scopeId);
  for (const [tabId, grant] of sessionGrants) {
    if (grant.scopeId === scopeId) sessionGrants.delete(tabId);
  }
  forgetPendingAuthorizations({ scopeId });
  scopeLeases.delete(scopeId);
  if (activeScope?.id === scopeId) {
    activeScope = null;
  }
  await persistSessionState();
  await publishStatus(false);
}

async function suspendAll() {
  for (const scopeId of controlIdleTimers.keys()) clearControlTimer(scopeId);
  await Promise.all([...attachedTabs.keys()].map(detachTab));
  await Promise.all([...managedScopes.keys()].map(collapseScopeGroups));
  const changed = pruneExpiredSessionState();
  if (changed) await persistSessionState();
  await publishStatus(false);
}

async function releaseAll() {
  await suspendAll();
  sessionGrants.clear();
  scopeLeases.clear();
  pendingAuthorizations.clear();
  activeScope = null;
  await persistSessionState();
  await publishStatus(false);
}

function touchControlTimer(scopeId) {
  clearControlTimer(scopeId);
  controlIdleTimers.set(scopeId, setTimeout(() => {
    controlIdleTimers.delete(scopeId);
    void suspendScope(scopeId);
  }, CONTROL_IDLE_TIMEOUT_MS));
}

function clearControlTimer(scopeId) {
  const timer = controlIdleTimers.get(scopeId);
  if (timer) clearTimeout(timer);
  controlIdleTimers.delete(scopeId);
}

async function addTabToScope(scope, tab) {
  if (tab?.id == null || tab.windowId == null) {
    throw connectorError('tab_group_failed', 'The browser did not return enough information to isolate the tab.');
  }
  const groupId = await ensureManagedGroup(scope, tab.windowId, tab.id);
  if (tab.groupId !== groupId) await chrome.tabs.group({ groupId, tabIds: tab.id });
  return groupId;
}

async function ensureManagedGroup(scope, windowId, seedTabId) {
  const known = managedScopes.get(scope.id);
  const existingGroupId = known?.groups.get(windowId);
  if (existingGroupId != null) {
    try {
      await chrome.tabGroups.get(existingGroupId);
      await chrome.tabGroups.update(existingGroupId, {
        title: groupTitle(known),
        color: GROUP_COLOR,
      });
      return existingGroupId;
    } catch {
      known.groups.delete(windowId);
      await persistManagedScopes();
    }
  }

  const creationKey = `${scope.id}:${windowId}`;
  const pending = groupCreations.get(creationKey);
  if (pending) return await pending;
  const creation = (async () => {
    const groupId = await chrome.tabs.group({ tabIds: seedTabId });
    const current = managedScopes.get(scope.id) ?? { id: scope.id, title: scope.title, groups: new Map() };
    current.groups.set(windowId, groupId);
    managedScopes.set(scope.id, current);
    await chrome.tabGroups.update(groupId, {
      title: groupTitle(current),
      color: GROUP_COLOR,
      collapsed: false,
    });
    await persistManagedScopes();
    return groupId;
  })();
  groupCreations.set(creationKey, creation);
  try {
    return await creation;
  } finally {
    groupCreations.delete(creationKey);
  }
}

async function activateScope(candidate) {
  let scope = managedScopes.get(candidate.id);
  if (!scope) {
    scope = { id: candidate.id, title: candidate.title, groups: new Map() };
    managedScopes.set(scope.id, scope);
    await persistManagedScopes();
  } else if (candidate.title && candidate.title !== scope.title) {
    scope.title = candidate.title;
    await Promise.all([...scope.groups.values()].map(async (groupId) => {
      try {
        await chrome.tabGroups.update(groupId, { title: groupTitle(scope), color: GROUP_COLOR });
      } catch {
        forgetManagedGroup(groupId);
      }
    }));
    await persistManagedScopes();
  }
  const now = Date.now();
  activeScope = scope;
  scopeLeases.set(scope.id, {
    id: scope.id,
    title: scope.title,
    lastRequestedAt: now,
    expiresAt: now + AUTHORIZATION_LEASE_TTL_MS,
  });
  await persistSessionState();
  return scope;
}

async function collapseScopeGroups(scopeId) {
  const scope = managedScopes.get(scopeId);
  if (!scope) return;
  let changed = false;
  for (const groupId of [...scope.groups.values()]) {
    try {
      // Collapsing an active group can move the user to another tab.
      const groupTabs = await chrome.tabs.query({ groupId });
      if (groupTabs.some(tab => tab.active)) continue;
      await chrome.tabGroups.update(groupId, { collapsed: true });
    } catch {
      changed = forgetManagedGroup(groupId) || changed;
    }
  }
  if (changed) await persistManagedScopes();
}

function managedGroupIds(scope) {
  return new Set((managedScopes.get(scope.id) ?? scope).groups?.values?.() ?? []);
}

function forgetManagedGroup(groupId) {
  let changed = false;
  for (const scope of managedScopes.values()) {
    for (const [windowId, candidateGroupId] of scope.groups) {
      if (candidateGroupId !== groupId) continue;
      scope.groups.delete(windowId);
      changed = true;
    }
  }
  return changed;
}

async function restoreManagedState() {
  try {
    const stored = await chrome.storage.session.get([
      MANAGED_SCOPES_STORAGE_KEY,
      ACTIVE_SCOPE_STORAGE_KEY,
      SESSION_GRANTS_STORAGE_KEY,
      SCOPE_LEASES_STORAGE_KEY,
      PENDING_AUTHORIZATIONS_STORAGE_KEY,
      TAB_REFERENCE_KEYS,
    ]);
    for (const entry of Array.isArray(stored[TAB_REFERENCE_KEYS]) ? stored[TAB_REFERENCE_KEYS] : []) {
      if (Array.isArray(entry) && Number.isSafeInteger(entry[0]) && entry[0] >= 0 &&
        typeof entry[1] === 'string' && /^external:[a-f0-9-]{36}:\d+$/.test(entry[1]) && entry[1].endsWith(`:${entry[0]}`)) tabReferenceKeys.set(entry[0], entry[1]);
    }
    const scopes = Array.isArray(stored[MANAGED_SCOPES_STORAGE_KEY])
      ? stored[MANAGED_SCOPES_STORAGE_KEY]
      : [];
    for (const candidate of scopes) {
      const scope = restoredScope(candidate);
      if (scope) managedScopes.set(scope.id, scope);
    }
    const grants = Array.isArray(stored[SESSION_GRANTS_STORAGE_KEY])
      ? stored[SESSION_GRANTS_STORAGE_KEY]
      : [];
    for (const candidate of grants) {
      const grant = restoredSessionGrant(candidate);
      if (grant && managedScopes.has(grant.scopeId)) sessionGrants.set(grant.tabId, grant);
    }
    const leases = Array.isArray(stored[SCOPE_LEASES_STORAGE_KEY])
      ? stored[SCOPE_LEASES_STORAGE_KEY]
      : [];
    for (const candidate of leases) {
      const lease = restoredScopeLease(candidate);
      if (lease && managedScopes.has(lease.id)) scopeLeases.set(lease.id, lease);
    }
    const pending = Array.isArray(stored[PENDING_AUTHORIZATIONS_STORAGE_KEY])
      ? stored[PENDING_AUTHORIZATIONS_STORAGE_KEY]
      : [];
    for (const candidate of pending) {
      const authorization = restoredPendingAuthorization(candidate);
      if (authorization && managedScopes.has(authorization.scopeId)) {
        pendingAuthorizations.set(pendingAuthorizationKey(authorization), authorization);
      }
    }
    const activeScopeId = cleanScopeId(stored[ACTIVE_SCOPE_STORAGE_KEY]);
    activeScope = activeScopeId ? managedScopes.get(activeScopeId) ?? null : null;
    if (pruneExpiredSessionState()) await persistSessionState();
  } catch (error) {
    lastError = `Unable to restore browser groups: ${errorMessage(error)}`;
  }
}

function restoredScope(candidate) {
  const id = cleanScopeId(candidate?.id);
  if (!id) return null;
  const title = cleanScopeTitle(candidate?.title, id);
  const groups = new Map();
  if (Array.isArray(candidate?.groups)) {
    for (const pair of candidate.groups) {
      const windowId = Number(pair?.[0]);
      const groupId = Number(pair?.[1]);
      if (Number.isSafeInteger(windowId) && Number.isSafeInteger(groupId) && groupId >= 0) {
        groups.set(windowId, groupId);
      }
    }
  }
  return { id, title, groups };
}

async function persistManagedScopes() {
  try {
    await chrome.storage.session.set({
      [MANAGED_SCOPES_STORAGE_KEY]: [...managedScopes.values()].map((scope) => ({
        id: scope.id,
        title: scope.title,
        groups: [...scope.groups],
      })),
    });
  } catch (error) {
    lastError = `Unable to save browser groups: ${errorMessage(error)}`;
  }
}

async function persistSessionState() {
  try {
    await chrome.storage.session.set({
      [ACTIVE_SCOPE_STORAGE_KEY]: activeScope?.id || '',
      [SESSION_GRANTS_STORAGE_KEY]: [...sessionGrants.values()].map((grant) => ({
        tabId: grant.tabId,
        scopeId: grant.scopeId,
        origins: [...grant.origins],
        source: grant.source,
      })),
      [SCOPE_LEASES_STORAGE_KEY]: [...scopeLeases.values()],
      [PENDING_AUTHORIZATIONS_STORAGE_KEY]: [...pendingAuthorizations.values()],
    });
  } catch (error) {
    lastError = `Unable to save browser authorization state: ${errorMessage(error)}`;
  }
}

async function publishStatus(includeError = true) {
  const port = nativePort;
  if (!port || !nativeReady) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (nativePort !== port || !nativeReady) return;
  port.postMessage({
    type: 'status',
    version: chrome.runtime.getManifest().version,
    activeTabId: tab?.id,
    activeTabTitle: tab?.title || '',
    activeTabUrl: tab?.url || '',
    controlledTabCount: attachedTabs.size,
    activeScopeId: activeScope?.id || '',
    activeScopeTitle: activeScope ? groupTitle(activeScope) : '',
    lastError: includeError ? lastError : '',
  });
}

async function popupState(preferredScopeId = '') {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = await chrome.storage.local.get(['allowedOrigins', 'allowAllSites', PAIRING_KEY]);
  let hasPairing = false;
  try { parseConnectorPairing(stored[PAIRING_KEY]); hasPairing = true; } catch { /* First use or explicitly removed. */ }
  const origin = originForTab(tab);
  const allowedOrigins = Array.isArray(stored.allowedOrigins) ? stored.allowedOrigins : [];
  const candidates = await popupScopeCandidates(tab);
  const selectedCandidate = selectPopupScopeCandidate(candidates, preferredScopeId);
  const selectedScope = selectedCandidate
    ? managedScopes.get(selectedCandidate.id) ?? null
    : null;
  const managedTab = selectedScope && tab ? await isTabManaged(selectedScope, tab) : false;
  return {
    runtimeBuild,
    connectorEnabled,
    nativeConnected: nativePort != null && nativeReady,
    hasPairing,
    pairingRequired,
    localConnectionRequested,
    requestingLocalConnection: localConnectionRequestEpoch === connectionEpoch,
    reconnectPaused,
    allowAllSites: stored.allowAllSites === true,
    allowedSiteCount: allowedOrigins.length,
    nativeConnecting: (nativePort != null || connectingEpoch === connectionEpoch) && !nativeReady && !lastError,
    controlledTabCount: attachedTabs.size,
    activeScope: selectedScope ? {
      id: selectedScope.id,
      title: selectedScope.title,
      groupTitle: groupTitle(selectedScope),
    } : null,
    scopeCandidates: candidates.map(({ priority: _priority, ...candidate }) => candidate),
    pendingAuthorization: selectedCandidate?.pending === true,
    managedTab,
    tab: tab ? publicTab(tab) : null,
    origin,
    access: tab?.id != null && selectedScope && sessionGrantAllows(selectedScope.id, tab.id, origin)
      ? 'once'
      : stored.allowAllSites === true
        ? 'all'
        : origin && allowedOrigins.includes(origin)
          ? 'site'
          : 'none',
    lastError,
  };
}

async function popupAuthorizationScope(preferredScopeId = '', currentTab = null) {
  const tab = currentTab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const candidate = selectPopupScopeCandidate(
    await popupScopeCandidates(tab),
    preferredScopeId,
  );
  return candidate ? managedScopes.get(candidate.id) ?? null : null;
}

async function popupScopeCandidates(tab) {
  if (pruneExpiredSessionState()) await persistSessionState();
  const origin = originForTab(tab);
  const now = Date.now();
  const candidates = [];
  for (const lease of scopeLeases.values()) {
    if (lease.expiresAt <= now) continue;
    const scope = managedScopes.get(lease.id);
    if (!scope) continue;
    const matchingPending = [...pendingAuthorizations.values()].filter((authorization) => (
      authorization.scopeId === scope.id &&
      authorization.expiresAt > now &&
      Boolean(origin) &&
      authorization.origin === origin
    ));
    const exactPending = matchingPending.some((authorization) => authorization.tabId === tab?.id);
    const managedTab = tab ? await isTabManaged(scope, tab) : false;
    candidates.push({
      id: scope.id,
      title: scope.title,
      groupTitle: groupTitle(scope),
      pending: matchingPending.length > 0,
      expiresAt: Math.max(lease.expiresAt, ...matchingPending.map((value) => value.expiresAt)),
      priority: exactPending ? 4 : managedTab ? 3 : matchingPending.length > 0 ? 2 : 1,
      lastRequestedAt: Math.max(
        lease.lastRequestedAt,
        ...matchingPending.map((value) => value.requestedAt),
      ),
    });
  }
  return candidates.sort((left, right) => (
    right.priority - left.priority || right.lastRequestedAt - left.lastRequestedAt
  ));
}

function selectPopupScopeCandidate(candidates, preferredScopeId = '') {
  const preferred = cleanScopeId(preferredScopeId);
  if (preferred) {
    const matched = candidates.find((candidate) => candidate.id === preferred);
    if (matched) return matched;
  }
  if (candidates.length === 1) return candidates[0];
  const highestPriority = candidates[0]?.priority ?? 0;
  if (highestPriority <= 1) return null;
  const strongest = candidates.filter((candidate) => candidate.priority === highestPriority);
  return strongest.length === 1 ? strongest[0] : null;
}

function setSessionGrant(tabId, scopeId, origin, source) {
  const existing = sessionGrants.get(tabId);
  const grant = existing?.scopeId === scopeId
    ? existing
    : { tabId, scopeId, origins: new Set(), source };
  if (origin) grant.origins.add(origin);
  if (source === 'created') grant.source = 'created';
  sessionGrants.set(tabId, grant);
}

function sessionGrantAllows(scopeId, tabId, origin) {
  const grant = sessionGrants.get(tabId);
  return grant?.scopeId === scopeId && (!origin || grant.origins.has(origin));
}

async function rememberPendingAuthorization(scope, tab, origin) {
  const now = Date.now();
  const authorization = {
    scopeId: scope.id,
    scopeTitle: scope.title,
    tabId: tab.id,
    windowId: tab.windowId,
    origin,
    requestedAt: now,
    expiresAt: now + AUTHORIZATION_LEASE_TTL_MS,
  };
  pendingAuthorizations.set(pendingAuthorizationKey(authorization), authorization);
  await persistSessionState();
}

function forgetPendingAuthorizations({ scopeId = '', tabId, origin = '' } = {}) {
  let changed = false;
  for (const [key, authorization] of pendingAuthorizations) {
    if (scopeId && authorization.scopeId !== scopeId) continue;
    if (tabId != null && authorization.tabId !== tabId) continue;
    if (origin && authorization.origin !== origin) continue;
    pendingAuthorizations.delete(key);
    changed = true;
  }
  return changed;
}

function pendingAuthorizationKey(authorization) {
  return JSON.stringify([
    authorization.scopeId,
    authorization.tabId,
    authorization.origin,
  ]);
}

function pruneExpiredSessionState() {
  const now = Date.now();
  let changed = false;
  for (const [scopeId, lease] of scopeLeases) {
    if (lease.expiresAt > now) continue;
    scopeLeases.delete(scopeId);
    changed = true;
  }
  for (const [key, authorization] of pendingAuthorizations) {
    if (authorization.expiresAt > now && scopeLeases.has(authorization.scopeId)) continue;
    pendingAuthorizations.delete(key);
    changed = true;
  }
  if (activeScope && !scopeLeases.has(activeScope.id)) {
    activeScope = null;
    changed = true;
  }
  return changed;
}

function restoredSessionGrant(candidate) {
  const tabId = Number(candidate?.tabId);
  const scopeId = cleanScopeId(candidate?.scopeId);
  if (!Number.isSafeInteger(tabId) || tabId < 0 || !scopeId) return null;
  const origins = new Set(
    Array.isArray(candidate?.origins)
      ? candidate.origins.filter((value) => typeof value === 'string' && value.length <= 2048)
      : [],
  );
  return {
    tabId,
    scopeId,
    origins,
    source: candidate?.source === 'created' ? 'created' : 'copied',
  };
}

function restoredScopeLease(candidate) {
  const id = cleanScopeId(candidate?.id);
  const lastRequestedAt = Number(candidate?.lastRequestedAt);
  const expiresAt = Number(candidate?.expiresAt);
  if (!id || !Number.isFinite(lastRequestedAt) || !Number.isFinite(expiresAt)) return null;
  return {
    id,
    title: cleanScopeTitle(candidate?.title, id),
    lastRequestedAt,
    expiresAt,
  };
}

function restoredPendingAuthorization(candidate) {
  const scopeId = cleanScopeId(candidate?.scopeId);
  const tabId = Number(candidate?.tabId);
  const windowId = Number(candidate?.windowId);
  const origin = typeof candidate?.origin === 'string' ? candidate.origin : '';
  const requestedAt = Number(candidate?.requestedAt);
  const expiresAt = Number(candidate?.expiresAt);
  if (
    !scopeId || !origin ||
    !Number.isSafeInteger(tabId) || tabId < 0 ||
    !Number.isSafeInteger(windowId) || windowId < 0 ||
    !Number.isFinite(requestedAt) || !Number.isFinite(expiresAt)
  ) return null;
  return {
    scopeId,
    scopeTitle: cleanScopeTitle(candidate?.scopeTitle, scopeId),
    tabId,
    windowId,
    origin,
    requestedAt,
    expiresAt,
  };
}

async function connectorState(scope) {
  return {
    connected: nativePort != null,
    controlledTabCount: [...attachedTabs.values()].filter((scopeId) => scopeId === scope.id).length,
    isolatedTabCount: (await listScopeTabs(scope)).length,
    scopeId: scope.id,
    groupTitle: groupTitle(scope),
    idleTimeoutMs: CONTROL_IDLE_TIMEOUT_MS,
  };
}

function publicTab(tab) {
  if (Number.isSafeInteger(tab.id) && !tabReferenceKeys.has(tab.id)) {
    tabReferenceKeys.set(tab.id, `external:${crypto.randomUUID()}:${tab.id}`);
    tabReferenceKeysDirty = true;
  }
  return {
    id: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId,
    active: tab.active === true,
    title: tab.title || '',
    url: tab.url || '',
    status: tab.status || '',
    targetKey: tabReferenceKeys.get(tab.id),
  };
}

async function persistTabReferenceKeys() {
  if (!tabReferenceKeysDirty) return;
  tabReferenceKeysDirty = false;
  try { await chrome.storage.session.set({ [TAB_REFERENCE_KEYS]: [...tabReferenceKeys] }); }
  catch { tabReferenceKeysDirty = true; /* An unpersisted key expires safely when this worker restarts. */ }
}

function originForTab(tab) {
  return originForUrl(tab?.url);
}

function originForUrl(value) {
  try {
    const parsed = new URL(value || '');
    if (parsed.protocol === 'file:') return 'file://';
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '';
  } catch {
    return '';
  }
}

function safeNavigationUrl(value) {
  const raw = String(value || 'about:blank').trim();
  if (raw === 'about:blank') return raw;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) throw new Error();
    return parsed.toString();
  } catch {
    throw connectorError('invalid_navigation_url', 'Only http, https, file, or about:blank URLs are supported.');
  }
}

function requiredScope(params) {
  const id = cleanScopeId(params?.scopeId);
  if (!id) {
    throw connectorError(
      'browser_scope_missing',
      'CardBush did not provide a browser session scope. Browser control was denied.',
    );
  }
  return { id, title: cleanScopeTitle(params?.scopeTitle, id), groups: new Map() };
}

function cleanScopeId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 160) : '';
}

function cleanScopeTitle(value, scopeId) {
  const cleaned = typeof value === 'string'
    ? value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 54)
    : '';
  return cleaned || `Session ${scopeId.slice(0, 8)}`;
}

function groupTitle(scope) {
  const suffix = scope.id.slice(-6);
  return `${GROUP_TITLE_PREFIX}${scope.title} · ${suffix}`.slice(0, 80);
}

function requiredTabId(value) {
  const tabId = Number(value);
  if (!Number.isSafeInteger(tabId) || tabId < 0) {
    throw connectorError('invalid_tab_id', 'A valid browser tab id is required.');
  }
  return tabId;
}

function connectorError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function normalizedError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'chrome_connector_failed',
    message: errorMessage(error),
    ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {}),
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
