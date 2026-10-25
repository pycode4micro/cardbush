const buttons = [...document.querySelectorAll('button')];
for (const button of buttons) button.addEventListener('click', async () => {
  buttons.forEach(value => { value.disabled = true; });
  try {
    const response = await chrome.runtime.sendMessage({ action: 'confirm_connection',
      token: location.hash.slice(1), allow: button.id === 'allow' });
    if (!response?.ok) throw new Error('连接申请已过期，请关闭此窗口后重新申请。');
    window.close();
  } catch (error) { document.querySelector('#status').textContent = error.message; }
});
