const language = chrome.i18n.getUILanguage();
document.documentElement.lang = language;
const t = CardBushExtensionI18n.uiText(language);
const token = location.hash.slice(1);
const status = document.querySelector('#status');
const cancel = document.querySelector('#cancel');
const once = document.querySelector('#once');
const site = document.querySelector('#site');
document.title = t('browser.extension.authorization.title');
document.querySelector('#heading').textContent = document.title;
document.querySelector('#description').textContent = t('browser.extension.authorization.description');
cancel.textContent = t('browser.extension.authorization.cancel');
once.textContent = t('browser.extension.authorization.once');
site.textContent = t('browser.extension.authorization.site');
status.textContent = t('browser.extension.authorization.loading');
let valid = false, busy = false, timer;
const expire = () => {
  valid = false; once.disabled = site.disabled = true;
  status.textContent = t('browser.extension.authorization.expired');
};
void (async () => {
  try {
    const state = await chrome.runtime.sendMessage({ action: 'site_state', token });
    if (!state?.ok || !Number.isFinite(state.expiresAt) || state.expiresAt <= Date.now()) { expire(); return; }
    document.querySelector('#origin').textContent = state.origin;
    document.querySelector('#scope').textContent = t('browser.extension.authorization.scope', { name: state.scopeTitle });
    valid = true; once.disabled = site.disabled = false; status.textContent = '';
    timer = setTimeout(expire, state.expiresAt - Date.now());
  } catch { expire(); }
})();
async function respond(allow) {
  if (busy || (!valid && allow !== false)) return;
  if (!valid) { window.close(); return; }
  busy = true; once.disabled = site.disabled = cancel.disabled = true;
  clearTimeout(timer);
  try {
    const result = await chrome.runtime.sendMessage({ action: 'confirm_site', token, allow });
    if (result?.ok) { window.close(); return; }
  } catch { /* A closed/revoked request cannot grant access. */ }
  expire(); cancel.disabled = false; busy = false;
}
cancel.addEventListener('click', () => { void respond(false); });
once.addEventListener('click', () => { void respond('once'); });
site.addEventListener('click', () => { void respond('site'); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); void respond(false); }
});
