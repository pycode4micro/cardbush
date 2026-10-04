const connection = document.querySelector('#connection');
const scope = document.querySelector('#scope');
const scopePicker = document.querySelector('#scope-picker');
const scopeSelect = document.querySelector('#scope-select');
const title = document.querySelector('#tab-title');
const origin = document.querySelector('#tab-origin');
const siteAccess = document.querySelector('#site-access');
const pairingDetails = document.querySelector('#pairing-details');
const extensionUpdate = document.querySelector('#extension-update');
const extensionUpdateMessage = document.querySelector('#extension-update-message');
const reloadExtension = document.querySelector('#reload-extension');
const popupBuild = globalThis.CARDBUSH_CONNECTOR_BUILD;
const buttons = [...document.querySelectorAll('button[data-action]')];
let selectedScopeId = '';
let lastPairingState;
let busy = false;
let refreshing = false;
let revision = 0;
let actionError = '';
let lastScopeOptions = '';

function needsReload(state) {
  // Older workers have no build ID. They must also be reloaded, even when
  // getManifest() in a freshly opened popup already reports the new version.
  return Boolean(popupBuild) && state.runtimeBuild !== popupBuild;
}

reloadExtension.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  revision++;
  actionError = '';
  reloadExtension.disabled = true;
  buttons.forEach(button => { button.disabled = true; });
  try {
    const state = await chrome.runtime.sendMessage({ action: 'status' });
    if (state?.ok === false) throw new Error(state.error?.message || '无法读取连接状态');
    if (!needsReload(state)) return;
    if (state.nativeConnected || state.nativeConnecting || state.controlledTabCount > 0) {
      throw new Error('连接或控制仍在进行。请先在 CardBush 中关闭连接器，再重新加载扩展。');
    }
    // Reload the existing installation. Never clear storage or replace pairing.
    chrome.runtime.reload();
  } catch (error) {
    actionError = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
    await refresh();
  }
});

scopeSelect.addEventListener('change', () => {
  revision++;
  selectedScopeId = scopeSelect.value;
  void refresh();
});

buttons.forEach((button) => button.addEventListener('click', async () => {
  busy = true;
  revision++;
  actionError = '';
  buttons.forEach((candidate) => { candidate.disabled = true; });
  reloadExtension.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({
      action: button.dataset.action,
      ...(button.dataset.action === 'pair' ? { code: document.querySelector('#pairing-code').value } : {}),
      ...(selectedScopeId ? { scopeId: selectedScopeId } : {}),
    });
    if (result?.ok === false) actionError = result.error?.message || '操作失败';
    else if (button.dataset.action === 'pair') document.querySelector('#pairing-code').value = '';
    if (result?.activeScope?.id) selectedScopeId = result.activeScope.id;
  } catch (error) {
    actionError = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
    await refresh();
  }
}));

async function refresh(reconnect = false) {
  if (busy || refreshing) return;
  refreshing = true;
  const requestRevision = revision;
  try {
    const state = await chrome.runtime.sendMessage({
      action: 'status',
      ...(reconnect ? { reconnect: true } : {}),
      ...(selectedScopeId ? { scopeId: selectedScopeId } : {}),
    });
    if (busy || requestRevision !== revision) return;
    if (state?.ok === false) throw new Error(state.error?.message || '无法读取连接状态');
    const staleWorker = needsReload(state);
    extensionUpdate.hidden = !staleWorker;
    reloadExtension.disabled = state.nativeConnected || state.nativeConnecting || state.controlledTabCount > 0;
    extensionUpdateMessage.textContent = reloadExtension.disabled
      ? '新版扩展尚未生效。请先在 CardBush 中关闭连接器，再重新加载扩展并开启连接器。已保存的配对与网站授权会保留。'
      : '新版扩展尚未生效。重新加载后将使用已保存的配对和网站授权，无需重新生成配对码。';
    const pairingState = staleWorker ? 'outdated' : Boolean(state.hasPairing);
    if (lastPairingState !== pairingState) {
      pairingDetails.open = !staleWorker && !state.hasPairing;
      lastPairingState = pairingState;
    }
    const candidates = Array.isArray(state.scopeCandidates) ? state.scopeCandidates : [];
    if (selectedScopeId && !candidates.some((candidate) => candidate.id === selectedScopeId)) {
      selectedScopeId = '';
    }
    if (!selectedScopeId && state.activeScope?.id) selectedScopeId = state.activeScope.id;
    const scopeOptions = JSON.stringify([candidates.map(({ id, title, pending }) => ({ id, title, pending })), selectedScopeId]);
    if (lastScopeOptions !== scopeOptions) {
      scopeSelect.replaceChildren(...[
        ...(candidates.length > 1 && !selectedScopeId
          ? [new Option('请选择目标会话', '', true, true)]
          : []),
        ...candidates.map((candidate) => new Option(
          `${candidate.pending ? '待授权 · ' : ''}${candidate.title}`,
          candidate.id,
          false,
          candidate.id === selectedScopeId,
        )),
      ]);
      lastScopeOptions = scopeOptions;
    }
    scopePicker.hidden = candidates.length <= 1;
    connection.textContent = actionError || (staleWorker
      ? '扩展后台仍在运行旧版本，需要重新加载。'
      : state.pairingRequired
      ? '尚未配对，或配对已被移除。请填写 CardBush 设置中的配对码。'
      : !state.connectorEnabled
      ? '扩展连接已关闭，配对与网站授权已保留。点击「连接 CardBush」即可恢复。'
      : state.nativeConnected
      ? state.controlledTabCount > 0
        ? `正在控制 ${state.controlledTabCount} 个标签页`
        : '已连接 CardBush，等待控制'
      : state.nativeConnecting
        ? '正在使用已保存的配对连接 CardBush…'
        : `CardBush 暂时离线，将自动重连。请确认应用和连接器已开启；无需重复授权。${state.lastError ? `\n${state.lastError}` : ''}`);
    connection.classList.toggle('offline', Boolean(actionError) || (!staleWorker && state.pairingRequired));
    connection.classList.toggle('waiting', staleWorker || (!state.nativeConnected && !state.pairingRequired && !actionError));
    siteAccess.textContent = staleWorker
      ? '已保存的授权不会因重新加载而清除；完整授权状态将在新版后台加载后显示。'
      : state.allowAllSites
      ? '已保存：允许隔离组访问全部网站。退出或重启后仍有效，可随时撤销。'
      : state.allowedSiteCount > 0
        ? `已保存 ${state.allowedSiteCount} 个网站的授权。退出或重启后仍有效。`
        : '尚未保存网站授权；「仅本次」只适用于当前浏览器会话。';
    scope.textContent = state.activeScope?.groupTitle
      ? `${state.pendingAuthorization ? '等待授权' : '目标组'}：${state.activeScope.groupTitle}`
      : candidates.length > 1
        ? '请选择要授权的 CardBush 会话'
        : '先在 CardBush 中发起浏览器任务';
    title.textContent = state.tab?.title || '当前标签页';
    origin.textContent = state.origin || state.tab?.url || '此页面不支持调试';
    buttons.forEach((button) => {
      const permissionAction = ['allow_once', 'allow_site', 'allow_all'].includes(button.dataset.action);
      button.disabled = permissionAction && (!state.nativeConnected || !state.activeScope || !state.origin);
      if (button.dataset.action === 'disable_connector') button.disabled = !state.connectorEnabled;
      if (button.dataset.action === 'reconnect') button.disabled = !state.hasPairing || state.nativeConnected || state.nativeConnecting;
      if (staleWorker && ['pair', 'reconnect', 'allow_once', 'allow_site', 'allow_all'].includes(button.dataset.action)) button.disabled = true;
      if (button.dataset.action === 'allow_all') button.textContent = state.allowAllSites
        ? '复制当前页 · 已允许全部网站'
        : '复制并允许隔离组访问全部网站';
      button.classList.toggle('active',
        (button.dataset.action === 'allow_once' && !state.allowAllSites && state.access === 'once') ||
        (button.dataset.action === 'allow_site' && !state.allowAllSites && state.access === 'site') ||
        (button.dataset.action === 'allow_all' && state.allowAllSites));
    });
  } catch (error) {
    if (requestRevision === revision && !busy) {
      connection.textContent = error instanceof Error ? error.message : String(error);
      connection.classList.add('offline');
    }
  } finally { refreshing = false; }
}

void refresh(true);
// The popup owns this timer; closing it destroys the document. No persistent
// polling worker is needed, and reconnecting updates an already-open popup.
setInterval(() => { void refresh(); }, 1000);
