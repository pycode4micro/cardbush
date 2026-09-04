const NATIVE_HOST = 'com.cardbush.browser_connector';
const DEBUGGER_PROTOCOL_VERSION = '1.3';
const CONTROL_IDLE_TIMEOUT_MS = 60_000;
const RECONNECT_ALARM = 'cardbush-native-reconnect';
const RECONNECT_DELAY_MINUTES = 0.5;
const MANAGED_SCOPES_STORAGE_KEY = 'cardbushManagedScopes';
const ACTIVE_SCOPE_STORAGE_KEY = 'cardbushActiveScope';
const GROUP_COLOR = 'cyan';
const GROUP_TITLE_PREFIX = 'CardBush · ';

let nativePort = null;
let lastError = '';
let activeScope = null;
const attachedTabs = new Map();
const onceAllowedTabs = new Map();
const managedScopes = new Map();
const controlIdleTimers = new Map();
const groupCreations = new Map();
const managedScopesReady = restoreManagedState();

connectNative();
chrome.runtime.onInstalled.addListener(connectNative);
chrome.runtime.onStartup.addListener(connectNative);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connectNative();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handlePopupMessage(message).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: normalizedError(error) });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  onceAllowedTabs.delete(tabId);
  attachedTabs.delete(tabId);
  void publishStatus();
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attachedTabs.delete(source.tabId);
  void publishStatus();
});

chrome.tabGroups.onRemoved.addListener((group) => {
  void managedScopesReady.then(async () => {
    if (forgetManagedGroup(group.id)) await persistManagedScopes();
  });
});

function connectNative() {
  if (nativePort) return;
  void chrome.alarms.clear(RECONNECT_ALARM);
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    lastError = '';
    port.onMessage.addListener((message) => {
      if (message?.type === 'connector_error') {
        lastError = String(message.message || message.code || 'Connector error');
        void publishStatus(false);
        return;
      }
      if (message?.type === 'control' && message.method === 'debugger.detachAll') {
        void detachAll();
        return;
      }
      if (message?.type === 'request') void handleNativeRequest(message);
    });
    port.onDisconnect.addListener(() => {
      lastError = chrome.runtime.lastError?.message || 'CardBush is not connected.';
      if (nativePort === port) nativePort = null;
      void detachAll();
      scheduleReconnect();
    });
    void publishStatus();
  } catch (error) {
    lastError = errorMessage(error);
    nativePort = null;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  void chrome.alarms.create(RECONNECT_ALARM, {
    delayInMinutes: RECONNECT_DELAY_MINUTES,
  });
}

async function handleNativeRequest(message) {
  const response = {
    type: 'response',
    id: message.id,
    clientId: message.clientId,
  };
  try {
    response.result = await dispatch(String(message.method || ''), message.params || {});
  } catch (error) {
    response.error = normalizedError(error);
  }
  nativePort?.postMessage(response);
  await publishStatus();
}

async function dispatch(method, params) {
  await managedScopesReady;
  const scope = requiredScope(params);
  await activateScope(scope);

  if (method === 'connector.status') return await connectorState(scope);
  if (method === 'tabs.list') return await listScopeTabs(scope);
  if (method === 'tabs.activate') {
    const tabId = requiredTabId(params.tabId);
    await requireManagedTab(scope, tabId);
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    return publicTab(tab);
  }
  if (method === 'tabs.create') {
    const tab = await chrome.tabs.create({ url: safeNavigationUrl(params.url), active: true });
    try {
      await addTabToScope(scope, tab);
    } catch (error) {
      if (tab.id != null) {
        try { await chrome.tabs.remove(tab.id); } catch { /* Best-effort rollback. */ }
      }
      throw error;
    }
    if (tab.id != null) onceAllowedTabs.set(tab.id, scope.id);
    return publicTab(await chrome.tabs.get(tab.id));
  }
  if (method === 'tabs.close') {
    const tabId = requiredTabId(params.tabId);
    await requireTabAccess(scope, tabId);
    await detachTab(tabId);
    await chrome.tabs.remove(tabId);
    return { closed: true, tabId };
  }
  if (method === 'tabs.navigate') {
    const tabId = requiredTabId(params.tabId);
    await requireTabAccess(scope, tabId);
    const action = String(params.action || 'url');
    if (action === 'back') await chrome.tabs.goBack(tabId);
    else if (action === 'forward') await chrome.tabs.goForward(tabId);
    else if (action === 'reload') await chrome.tabs.reload(tabId, { bypassCache: params.ignoreCache === true });
    else await chrome.tabs.update(tabId, { url: safeNavigationUrl(params.url) });
    return publicTab(await chrome.tabs.get(tabId));
  }
  if (method === 'debugger.command') {
    const tabId = requiredTabId(params.tabId);
    await requireTabAccess(scope, tabId);
    await ensureAttached(scope, tabId);
    touchControlTimer(scope.id);
    return await chrome.debugger.sendCommand(
      { tabId },
      String(params.command || ''),
      params.commandParams && typeof params.commandParams === 'object'
        ? params.commandParams
        : {},
    ) || {};
  }
  if (method === 'debugger.detach') {
    const tabId = requiredTabId(params.tabId);
    await requireManagedTab(scope, tabId);
    await detachTab(tabId);
    return { detached: true, tabId };
  }
  if (method === 'debugger.detachScope') {
    await detachScope(scope.id);
    return { detached: true, scopeId: scope.id };
  }
  throw connectorError('unsupported_method', `Unsupported connector method: ${method}`);
}

async function handlePopupMessage(message) {
  await managedScopesReady;
  const action = String(message?.action || 'status');
  if (action === 'status') return { ok: true, ...(await popupState()) };
  if (action === 'reconnect') {
    connectNative();
    return { ok: true, ...(await popupState()) };
  }
  if (action === 'disconnect') {
    if (activeScope) await detachScope(activeScope.id);
    else await detachAll();
    return { ok: true, ...(await popupState()) };
  }
  if (action === 'revoke') {
    onceAllowedTabs.clear();
    await chrome.storage.local.set({ allowAllSites: false, allowedOrigins: [] });
    await detachAll();
    return { ok: true, ...(await popupState()) };
  }
  if (!['allow_once', 'allow_site', 'allow_all'].includes(action)) {
    throw connectorError('unsupported_popup_action', `Unsupported action: ${action}`);
  }
  if (!nativePort) {
    throw connectorError(
      'cardbush_not_connected',
      'Open CardBush and start a browser task before adding an existing Chrome tab.',
    );
  }
  if (!activeScope) {
    throw connectorError(
      'browser_scope_missing',
      'Start a browser task in CardBush before adding an existing Chrome tab.',
    );
  }

  const [sourceTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (sourceTab?.id == null) throw connectorError('active_tab_missing', 'No active Chrome tab is available.');
  const origin = originForTab(sourceTab);
  if (!origin) throw connectorError('unsupported_page', 'This Chrome page cannot be controlled.');

  const managedTab = await copyTabIntoScope(activeScope, sourceTab);
  if (managedTab.id == null) throw connectorError('active_tab_missing', 'The copied Chrome tab has no id.');
  if (action === 'allow_once') {
    onceAllowedTabs.set(managedTab.id, activeScope.id);
  } else if (action === 'allow_site') {
    const stored = await chrome.storage.local.get(['allowedOrigins']);
    const origins = new Set(Array.isArray(stored.allowedOrigins) ? stored.allowedOrigins : []);
    origins.add(origin);
    await chrome.storage.local.set({ allowedOrigins: [...origins] });
  } else {
    await chrome.storage.local.set({ allowAllSites: true });
  }

  connectNative();
  await publishStatus();
  return { ok: true, copiedTabId: managedTab.id, ...(await popupState()) };
}

async function copyTabIntoScope(scope, sourceTab) {
  if (await isTabManaged(scope, sourceTab)) return sourceTab;
  const copied = await chrome.tabs.duplicate(sourceTab.id);
  if (copied?.id == null) throw connectorError('tab_copy_failed', 'Chrome did not return the copied tab.');
  try {
    await addTabToScope(scope, copied);
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

async function requireTabAccess(scope, tabId) {
  const tab = await requireManagedTab(scope, tabId);
  if (onceAllowedTabs.get(tabId) === scope.id) return tab;
  const origin = originForTab(tab);
  if (!origin) {
    throw connectorError('unsupported_page', 'Chrome does not permit extensions to debug this page.');
  }
  const stored = await chrome.storage.local.get(['allowedOrigins', 'allowAllSites']);
  const allowedOrigins = Array.isArray(stored.allowedOrigins) ? stored.allowedOrigins : [];
  if (stored.allowAllSites !== true && !allowedOrigins.includes(origin)) {
    throw connectorError(
      'site_permission_required',
      `Open the CardBush Browser Connector in Chrome and allow access to ${origin}.`,
      { tabId, origin, scopeId: scope.id },
    );
  }
  return tab;
}

async function ensureAttached(scope, tabId) {
  const attachedScopeId = attachedTabs.get(tabId);
  if (attachedScopeId === scope.id) return;
  if (attachedScopeId) await detachTab(tabId);
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    attachedTabs.set(tabId, scope.id);
  } catch (error) {
    throw connectorError('debugger_attach_failed', errorMessage(error), { tabId });
  }
  await publishStatus();
}

async function detachTab(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Chrome may already have detached the tab during navigation or close.
  }
  attachedTabs.delete(tabId);
}

async function detachScope(scopeId) {
  clearControlTimer(scopeId);
  const tabIds = [...attachedTabs]
    .filter(([, attachedScopeId]) => attachedScopeId === scopeId)
    .map(([tabId]) => tabId);
  await Promise.all(tabIds.map(detachTab));
  for (const [tabId, allowedScopeId] of onceAllowedTabs) {
    if (allowedScopeId === scopeId) onceAllowedTabs.delete(tabId);
  }
  await collapseScopeGroups(scopeId);
  if (activeScope?.id === scopeId) {
    activeScope = null;
    await persistActiveScope();
  }
  await publishStatus(false);
}

async function detachAll() {
  for (const scopeId of controlIdleTimers.keys()) clearControlTimer(scopeId);
  await Promise.all([...attachedTabs.keys()].map(detachTab));
  onceAllowedTabs.clear();
  await Promise.all([...managedScopes.keys()].map(collapseScopeGroups));
  activeScope = null;
  await persistActiveScope();
  await publishStatus(false);
}

function touchControlTimer(scopeId) {
  clearControlTimer(scopeId);
  controlIdleTimers.set(scopeId, setTimeout(() => {
    controlIdleTimers.delete(scopeId);
    void detachScope(scopeId);
  }, CONTROL_IDLE_TIMEOUT_MS));
}

function clearControlTimer(scopeId) {
  const timer = controlIdleTimers.get(scopeId);
  if (timer) clearTimeout(timer);
  controlIdleTimers.delete(scopeId);
}

async function addTabToScope(scope, tab) {
  if (tab?.id == null || tab.windowId == null) {
    throw connectorError('tab_group_failed', 'Chrome did not return enough information to isolate the tab.');
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
        collapsed: false,
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
  if (activeScope?.id !== scope.id || activeScope.title !== scope.title) {
    activeScope = scope;
    await persistActiveScope();
  }
  return scope;
}

async function collapseScopeGroups(scopeId) {
  const scope = managedScopes.get(scopeId);
  if (!scope) return;
  let changed = false;
  for (const groupId of [...scope.groups.values()]) {
    try {
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
    ]);
    const scopes = Array.isArray(stored[MANAGED_SCOPES_STORAGE_KEY])
      ? stored[MANAGED_SCOPES_STORAGE_KEY]
      : [];
    for (const candidate of scopes) {
      const scope = restoredScope(candidate);
      if (scope) managedScopes.set(scope.id, scope);
    }
    const activeScopeId = cleanScopeId(stored[ACTIVE_SCOPE_STORAGE_KEY]);
    activeScope = activeScopeId ? managedScopes.get(activeScopeId) ?? null : null;
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

async function persistActiveScope() {
  try {
    await chrome.storage.session.set({
      [ACTIVE_SCOPE_STORAGE_KEY]: activeScope?.id || '',
    });
  } catch (error) {
    lastError = `Unable to save the active browser group: ${errorMessage(error)}`;
  }
}

async function publishStatus(includeError = true) {
  if (!nativePort) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  nativePort.postMessage({
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

async function popupState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = await chrome.storage.local.get(['allowedOrigins', 'allowAllSites']);
  const origin = originForTab(tab);
  const allowedOrigins = Array.isArray(stored.allowedOrigins) ? stored.allowedOrigins : [];
  const managedTab = activeScope && tab ? await isTabManaged(activeScope, tab) : false;
  return {
    nativeConnected: nativePort != null,
    controlledTabCount: attachedTabs.size,
    activeScope: activeScope ? {
      id: activeScope.id,
      title: activeScope.title,
      groupTitle: groupTitle(activeScope),
    } : null,
    managedTab,
    tab: tab ? publicTab(tab) : null,
    origin,
    access: tab?.id != null && activeScope && onceAllowedTabs.get(tab.id) === activeScope.id
      ? 'once'
      : stored.allowAllSites === true
        ? 'all'
        : origin && allowedOrigins.includes(origin)
          ? 'site'
          : 'none',
    lastError,
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
  return {
    id: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId,
    active: tab.active === true,
    title: tab.title || '',
    url: tab.url || '',
    status: tab.status || '',
  };
}

function originForTab(tab) {
  try {
    const parsed = new URL(tab?.url || '');
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
    throw connectorError('invalid_tab_id', 'A valid Chrome tab id is required.');
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
