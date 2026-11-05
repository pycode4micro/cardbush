document.documentElement.lang = chrome.i18n.getUILanguage();
const t = CardBushExtensionI18n.uiText(document.documentElement.lang);
for (const [selector, key] of Object.entries({
  '#connection-title': 'title', '#heading': 'heading', '#connection-isolation': 'isolation',
  '#connection-reconnect': 'reconnect', '#status': 'waiting', '#allow': 'allow', '#cancel': 'cancel',
})) document.querySelector(selector).textContent = t('browser.extension.connection.' + key);
document.title = t('browser.extension.connection.title');
const allowButton = document.querySelector('#allow');
const cancelButton = document.querySelector('#cancel');
const status = document.querySelector('#status');
const token = location.hash.slice(1);
let valid = false, busy = false, expiry;
cancelButton.focus({ preventScroll: true });
const expire = () => {
  valid = false; allowButton.disabled = true;
  status.textContent = t('browser.extension.connection.expired');
};

void (async () => {
  try {
    const state = await chrome.runtime.sendMessage({ action: 'connection_state', token });
    if (!state?.ok || !['chrome', 'edge'].includes(state.browser) || !Number.isFinite(state.expiresAt) || state.expiresAt <= Date.now()) { expire(); return; }
    document.querySelector('#description').textContent = t('browser.extension.connection.description', { browser: state.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome' });
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
