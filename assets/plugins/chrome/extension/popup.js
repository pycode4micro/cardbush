const connection = document.querySelector('#connection');
const scope = document.querySelector('#scope');
const title = document.querySelector('#tab-title');
const origin = document.querySelector('#tab-origin');
const buttons = [...document.querySelectorAll('button[data-action]')];

buttons.forEach((button) => button.addEventListener('click', async () => {
  buttons.forEach((candidate) => { candidate.disabled = true; });
  let actionError = '';
  try {
    const result = await chrome.runtime.sendMessage({ action: button.dataset.action });
    if (result?.ok === false) actionError = result.error?.message || '操作失败';
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
  const state = await chrome.runtime.sendMessage({ action: 'status' });
  connection.textContent = state.nativeConnected
    ? state.controlledTabCount > 0
      ? `正在控制 ${state.controlledTabCount} 个标签页`
      : '已连接 CardBush，等待控制'
    : 'CardBush 未连接，请先打开应用并配置本地桥';
  connection.classList.toggle('offline', !state.nativeConnected);
  scope.textContent = state.activeScope?.groupTitle
    ? `目标组：${state.activeScope.groupTitle}`
    : '先在 CardBush 中发起浏览器任务';
  title.textContent = state.tab?.title || '当前标签页';
  origin.textContent = state.origin || state.tab?.url || '此页面不支持调试';
  buttons.forEach((button) => {
    const permissionAction = ['allow_once', 'allow_site', 'allow_all'].includes(button.dataset.action);
    button.disabled = permissionAction && (!state.nativeConnected || !state.activeScope);
    button.classList.toggle('active',
      (button.dataset.action === 'allow_once' && state.access === 'once') ||
      (button.dataset.action === 'allow_site' && state.access === 'site') ||
      (button.dataset.action === 'allow_all' && state.access === 'all'));
  });
}

void refresh();
