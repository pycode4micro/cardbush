const connection = document.querySelector('#connection');
const scope = document.querySelector('#scope');
const scopePicker = document.querySelector('#scope-picker');
const scopeSelect = document.querySelector('#scope-select');
const title = document.querySelector('#tab-title');
const origin = document.querySelector('#tab-origin');
const buttons = [...document.querySelectorAll('button[data-action]')];
let selectedScopeId = '';

scopeSelect.addEventListener('change', () => {
  selectedScopeId = scopeSelect.value;
  void refresh();
});

buttons.forEach((button) => button.addEventListener('click', async () => {
  buttons.forEach((candidate) => { candidate.disabled = true; });
  let actionError = '';
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
    buttons.forEach((candidate) => { candidate.disabled = false; });
    await refresh();
    if (actionError) {
      connection.textContent = actionError;
      connection.classList.add('offline');
    }
  }
}));

async function refresh() {
  const state = await chrome.runtime.sendMessage({
    action: 'status',
    ...(selectedScopeId ? { scopeId: selectedScopeId } : {}),
  });
  const candidates = Array.isArray(state.scopeCandidates) ? state.scopeCandidates : [];
  if (selectedScopeId && !candidates.some((candidate) => candidate.id === selectedScopeId)) {
    selectedScopeId = '';
  }
  if (!selectedScopeId && state.activeScope?.id) selectedScopeId = state.activeScope.id;
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
  scopePicker.hidden = candidates.length <= 1;
  connection.textContent = !state.connectorEnabled
    ? '扩展连接已关闭。首次使用请填写配对码；已配对可点击连接 CardBush。'
    : state.nativeConnected
    ? state.controlledTabCount > 0
      ? `正在控制 ${state.controlledTabCount} 个标签页`
      : '已连接 CardBush，等待控制'
    : state.reconnectPaused
      ? `自动重连已暂停。请确认 CardBush 连接器已开启，再点击连接；移除过配置则需要重新配对。${state.lastError ? `（${state.lastError}）` : ''}`
    : state.lastError
      ? `CardBush 连接失败：${state.lastError}`
      : state.nativeConnecting
        ? '正在连接 CardBush 本地桥…'
        : 'CardBush 未连接，请先打开应用并配置本地桥';
  connection.classList.toggle('offline', !state.nativeConnected);
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
    button.classList.toggle('active',
      (button.dataset.action === 'allow_once' && state.access === 'once') ||
      (button.dataset.action === 'allow_site' && state.access === 'site') ||
      (button.dataset.action === 'allow_all' && state.access === 'all'));
  });
}

void refresh();
