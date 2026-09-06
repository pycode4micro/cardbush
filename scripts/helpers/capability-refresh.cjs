const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  await run(`
    window.hookReact = require(${JSON.stringify(require.resolve('react'))});
    window.catalogListeners = new Set();
    window.catalogReads = [];
    cardbushDesktop.onCapabilityCatalogChanged = callback => {
      catalogListeners.add(callback); return () => catalogListeners.delete(callback);
    };
    window.CatalogFixture = function () {
      const [label, setLabel] = hookReact.useState('initial');
      const refresh = hookReact.useCallback(async isCurrent => {
        const value = await new Promise(resolve => catalogReads.push(resolve));
        if (isCurrent()) setLabel(value);
      }, []);
      views.useCapabilityCatalogRefresh(refresh);
      return h('div', null, h('span', { id: 'catalog-label' }, label), h('input', { id: 'catalog-draft', defaultValue: 'unsaved draft' }));
    };
    renderView(h(CatalogFixture));
  `);
  await until('catalogListeners.size === 1', 'StrictMode keeps one catalog subscription');
  await run(`window.savedDraft = document.getElementById('catalog-draft');
    for (let i = 0; i < 8; i++) for (const callback of catalogListeners) callback();`);
  await until('catalogReads.length === 1', 'debounced catalog refresh');
  await run('for (const callback of catalogListeners) callback();');
  await pause(150);
  assert.equal(await run('catalogReads.length'), 1, 'refreshes do not overlap');
  await run("catalogReads[0]('stale');");
  await until('catalogReads.length === 2', 'queued newer refresh');
  assert.equal(await run("document.getElementById('catalog-label').textContent"), 'initial');
  await run("catalogReads[1]('new skill');");
  await until("document.getElementById('catalog-label').textContent === 'new skill'", 'latest catalog applied');
  assert.equal(await run("savedDraft === document.getElementById('catalog-draft') && savedDraft.value === 'unsaved draft'"), true, 'catalog update preserves mounted editor and draft');
  await run('renderView(null)');
  await until('catalogListeners.size === 0', 'catalog subscription cleanup');
  await run('delete cardbushDesktop.onCapabilityCatalogChanged');
  console.log('Live catalog UI passed: StrictMode, event debounce, serialized refresh, stale response fencing, retained editor and cleanup.');
};
