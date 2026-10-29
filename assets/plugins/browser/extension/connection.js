const allowButton = document.querySelector('#allow');
const cancelButton = document.querySelector('#cancel');
const status = document.querySelector('#status');
const token = location.hash.slice(1);
let valid = false, busy = false, expiry;
cancelButton.focus({ preventScroll: true });
const expire = () => {
  valid = false; allowButton.disabled = true;
  status.textContent = '连接申请已结束。关闭此窗口后，可在扩展中重新申请。';
};

void (async () => {
  try {
    const state = await chrome.runtime.sendMessage({ action: 'connection_state', token });
    if (!state?.ok || !['chrome', 'edge'].includes(state.browser) || !Number.isFinite(state.expiresAt) || state.expiresAt <= Date.now()) { expire(); return; }
    document.querySelector('#browser-name').textContent = state.browser === 'edge' ? ' Microsoft Edge' : ' Google Chrome';
    valid = true; allowButton.disabled = false; status.textContent = '';
    expiry = setTimeout(expire, Math.min(state.expiresAt - Date.now(), 60_000));
  } catch { expire(); }
})();

async function respond(allow) {
  if (busy || (allow && !valid)) return;
  if (!allow && !valid) { window.close(); return; }
  busy = true; allowButton.disabled = true; cancelButton.disabled = true;
  clearTimeout(expiry);
  try {
    const result = await chrome.runtime.sendMessage({ action: 'confirm_connection', token, allow });
    if (!result?.ok) { expire(); cancelButton.disabled = false; busy = false; return; }
    window.close();
  } catch { expire(); cancelButton.disabled = false; busy = false; }
}
allowButton.addEventListener('click', () => { void respond(true); });
cancelButton.addEventListener('click', () => { void respond(false); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); void respond(false); }
});
