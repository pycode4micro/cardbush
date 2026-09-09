// Optional read-only integration check. Uses temporary data, never installs or enables a plugin.
const { app, net, session } = require('electron');
const { join, resolve } = require('node:path');
const { PluginMarketplaceService } = require('../dist-electron/pluginMarketplaces.js');
const assert = require('node:assert/strict');
const root = resolve(process.argv[2]);
app.setPath('userData', join(root, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Live marketplace check timed out.'); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  try {
    await session.defaultSession.setProxy({ mode: 'system' });
    const service = new PluginMarketplaceService({ dataRoot: join(root, 'markets'), userPluginRoot: join(root, 'installed'), bundledPluginRoot: resolve('assets/plugins'), fetch: (input, init) => net.fetch(String(input), init) });
    const source = await service.addGitHub('anthropics/claude-plugins-official');
    const catalog = await service.catalog(source.id);
    console.log(`Live Claude market: ${catalog.entries.length} entries.`);
    for (const name of ['frontend-design', 'code-simplifier', 'commit-commands', 'explanatory-output-style']) {
      const preview = await service.preview(source.id, name);
      console.log(JSON.stringify({ name, components: preview.components.map(item => item.kind), issues: preview.issues, notes: preview.notes }));
      if (preview.issues.length) throw new Error(`${name} preview did not pass.`);
    }
    const unsupported = await service.preview(source.id, 'security-guidance');
    assert.ok(unsupported.issues.some(issue => issue.code === 'extension' && issue.detail.includes('asyncRewake')), 'async wake hooks must not be silently accepted');
    console.log('security-guidance correctly reports unsupported asyncRewake hooks.');
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
});
