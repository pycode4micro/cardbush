const assert = require('node:assert/strict');

module.exports = async ({ original, origin, read, waitFor, activeReady, pause, faviconFixture }) => {
  const icon = '.right-inspector-tab.active .browser-site-icon';
  const stored = () => read(`JSON.parse(localStorage.getItem('cardbush.browser_site_icons.v1')||'[]').find(([site])=>site===${JSON.stringify(origin)})?.[1]`);
  const clear = () => read(`localStorage.removeItem('cardbush.browser_site_icons.v1');dispatchEvent(new StorageEvent('storage',{key:'cardbush.browser_site_icons.v1'}));void 0`);
  const loaded = async path => {
    try { await waitFor(`document.querySelector('${icon} img')?.src===${JSON.stringify(origin + path)}&&document.querySelector('${icon} img')?.naturalWidth>0`, `working favicon ${path}`); }
    catch (error) {
      console.error('Favicon diagnostics', { requests: [...faviconFixture.requests], state: await read(`({navigation:browserFixture.navigation[browserFixture.activeId],icon:document.querySelector('${icon}')?.outerHTML})`) });
      throw error;
    }
  };

  await original.loadURL(origin + '/icon-retry'); await activeReady();
  await loaded('/retry-icon.svg');
  assert.ok(faviconFixture.requests.get('/retry-icon.svg') >= 2, 'a transient image failure retries without user interaction');
  assert.equal(await stored(), origin + '/retry-icon.svg', 'only successfully decoded images become site icons');

  await clear();
  await original.loadURL(origin + '/icon-reload'); await activeReady();
  await waitFor(`browserFixture.navigation[browserFixture.activeId]?.faviconUrl===${JSON.stringify(origin + '/reload-icon.svg')}`);
  await waitFor(`document.querySelector('${icon} > svg')!==null`, 'failed images use the globe');
  await pause(1600);
  await waitFor(`document.querySelector('${icon} > svg')!==null`, 'bounded retry exhausted');
  const attempts = faviconFixture.requests.get('/reload-icon.svg');
  await pause(1200);
  assert.equal(faviconFixture.requests.get('/reload-icon.svg'), attempts, 'permanently missing icons do not poll forever');
  assert.equal(await stored(), undefined, 'broken candidates never overwrite the site cache');
  const revision = await read('browserFixture.navigation[browserFixture.activeId].faviconRevision');
  faviconFixture.recovered = true;
  original.reload();
  await waitFor(`browserFixture.navigation[browserFixture.activeId].faviconRevision>${revision}`);
  await activeReady(); await loaded('/reload-icon.svg');
  assert.equal(await stored(), origin + '/reload-icon.svg', 'refresh retries an unchanged favicon URL');

  await clear();
  await original.loadURL(origin + '/icon-candidates'); await activeReady();
  await loaded('/working-icon.svg');
  const candidates = await read('browserFixture.navigation[browserFixture.activeId].faviconUrls');
  assert.deepEqual(candidates, [origin + '/missing-icon.svg', origin + '/working-icon.svg']);
  assert.ok(faviconFixture.requests.has('/missing-icon.svg'), 'first candidate really failed');
  assert.equal(await stored(), origin + '/working-icon.svg', 'second working candidate is reused by bookmarks/frequent sites');
  await original.executeJavaScript('history.pushState({}, "", "#chart");void 0');
  await waitFor(`browserFixture.navigation[browserFixture.activeId]?.url.endsWith('#chart')`);
  assert.deepEqual(await read('browserFixture.navigation[browserFixture.activeId].faviconUrls'), candidates, 'same-document navigation retains all candidates');
  await loaded('/working-icon.svg');
  console.log('Browser favicons passed: transient recovery, bounded retries, same-URL reload, native candidate fallback, verified cache and same-document navigation.');
};
