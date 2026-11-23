const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  await run(`
    renderView(null);
    window.catalogStorage = Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return [key, localStorage.getItem(key)];
    });
    window.originalProductHost = window.cardbushDesktop;
    window.catalogWrites = [];
    window.catalogErrors = [];
    const protocol = 'cardbush.product_host_ipc.v1';
    const models = ['a', 'b'].map(id => ({ id, provider: 'custom', modelName: id, apiKey: '', baseUrl: 'https://example.test/v1' }));
    let reads = 0;
    window.catalogRemote = { models, defaultModelId: 'a', revision: 'revision-0' };
    localStorage.setItem('cardbush_managed_model_configs', JSON.stringify(models));
    localStorage.setItem('cardbush.selected_model', 'a');
    window.cardbushDesktop = { ...window.cardbushDesktop, showErrorDialog: error => catalogErrors.push(error), productHostCommand: ({ kind, config }) => {
      if (kind === 'models.get') {
        if (++reads === 1) return { protocol, ok: false, error: { code: 'fixture_unavailable' } };
        return { protocol, ok: true, value: catalogRemote };
      }
      if (kind !== 'models.update') throw Error('Unexpected catalogue command');
      return new Promise((resolve, reject) => catalogWrites.push({
        id: config.defaultModelId,
        expectedRevision: config.expectedRevision,
        succeed: revision => {
          catalogRemote = { models: config.models, defaultModelId: config.defaultModelId, revision };
          resolve({ protocol, ok: true, value: catalogRemote });
        },
        fail: () => reject(Error('Synthetic failure')),
        conflict: () => resolve({ protocol, ok: false, error: { code: 'model_config_revision_conflict', message: 'Synthetic conflict' } }),
      }));
    }};
    function CatalogFixture() {
      const [settings, updateSettings] = views.useAppSettings();
      window.modelCatalog = views.useLocalModelCatalog(settings.managedModelConfigs, updateSettings);
      return h('output', { 'data-model-sync': modelCatalog.ready }, modelCatalog.defaultModelId);
    }
    renderView(h(CatalogFixture));
  `);
  try {
    await until('window.modelCatalog?.ready && modelCatalog.defaultModelId === "a"', 'local catalogue fallback');
    await pause();
    assert.equal(await run('catalogWrites.length'), 0, 'a failed host read must never write the cached catalogue');
    for (const id of ['b', 'a', 'b']) {
      await run(`modelCatalog.setDefaultModelId(${JSON.stringify(id)})`);
      await until(`modelCatalog.defaultModelId === ${JSON.stringify(id)}`, `desired shared default ${id}`);
      await pause();
    }
    assert.deepEqual(await run('catalogWrites.map(write => write.id)'), ['b'], 'there is one host write in flight');
    await run('catalogWrites[0].fail()');
    await until('catalogWrites.length === 2', 'the failed request does not block the next write');
    assert.equal(await run('catalogWrites[1].id'), 'a');
    await run('catalogWrites[1].succeed("revision-1")');
    await until('catalogWrites.length === 3', 'after restoring A, the newer B intent reaches the host');
    assert.equal(await run('modelCatalog.defaultModelId'), 'b', 'an old success never rolls back the current selection');
    await run('catalogWrites[2].succeed("revision-2")');
    await pause();
    assert.deepEqual(await run('catalogWrites.map(write => write.id)'), ['b', 'a', 'b']);
    assert.deepEqual(await run('catalogWrites.map(write => write.expectedRevision)'), ['revision-0', 'revision-0', 'revision-1']);
    assert.equal(await run('modelCatalog.defaultModelId'), 'b');

    await run('modelCatalog.setDefaultModelId("a")');
    await until('catalogWrites.length === 4', 'the first draft is in flight');
    await run('modelCatalog.setDefaultModelId("b")');
    await until('modelCatalog.defaultModelId === "b"', 'the second draft is queued');
    await pause();
    await run(`
      catalogRemote = {
        models: catalogRemote.models.map(model => model.id === 'a' ? { ...model, modelName: 'renamed remotely' } : model),
        defaultModelId: 'a',
        revision: 'remote-revision',
      };
      catalogWrites[3].conflict();
    `);
    await until('modelCatalog.defaultModelId === "a" && modelCatalog.availableModels.some(model => model.modelName === "renamed remotely") && catalogErrors.length === 1', 'conflict reloads the newer catalogue and notifies the user');
    await pause();
    assert.equal(await run('catalogWrites.length'), 4, 'the queued draft cannot overwrite the newer settings');
    await run('modelCatalog.setDefaultModelId("b")');
    await until('catalogWrites.length === 5', 'a fresh edit can proceed after reloading');
    assert.equal(await run('catalogWrites[4].expectedRevision'), 'remote-revision');
    await run('catalogWrites[4].succeed("revision-3")');
    console.log('Local model catalogue passed: failed-read recovery, ordered writes, stale receipts and cross-client conflicts.');
  } finally {
    await run(`
      renderView(null);
      window.cardbushDesktop = window.originalProductHost;
      localStorage.clear();
      for (const [key, value] of catalogStorage) localStorage.setItem(key, value);
    `);
  }
};
