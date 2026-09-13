const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, window: win, root, click }) => {
  await run(`
    window.maintenanceCommands = []; window.maintenanceReloads = []; window.maintenanceConfirmations = [];
    window.allowMaintenance = false;
    window.confirm = text => { maintenanceConfirmations.push(text); return allowMaintenance; };
    window.legacyReset = {
      protocol: 'cardbush.runtime_asset_reset.v1', restartRequired: true, changed: true,
      selectedCategories: ['agent_profiles', 'teams'],
      categories: { teams: { restoredFileCount: 1 }, agent_profiles: { restoredFileCount: 1 } },
    };
    localStorage.setItem('cardbush_pending_runtime_asset_reset', JSON.stringify(legacyReset));
    cardbushDesktop.productHostCommand = async command => {
      maintenanceCommands.push(command);
      const categories = {
        prompts: { source_path: 'bundled/prompts', target_path: 'compiled/prompts' },
        skills: { source_path: 'bundled/skills', target_path: 'fixture/skills' },
        teams: { source_path: 'legacy/team', target_path: 'legacy/team' },
        agent_profiles: { source_path: 'legacy/profiles', target_path: 'legacy/profiles' },
      };
      const base = { protocol: 'cardbush.runtime_asset_reset.v1', categories };
      if (command.kind === 'maintenance.runtime_assets.plan') return { protocol: command.protocol, ok: true, value: base };
      if (command.kind === 'maintenance.runtime_assets.reset') return { protocol: command.protocol, ok: true,
        value: { ...base, selected_categories: [...command.categories, 'teams', 'agent_profiles'], changed: true, restart_required: false } };
      throw Error('Unexpected maintenance command: ' + command.kind);
    };
    settingsProps.backendCapabilities = { ...settingsProps.backendCapabilities, maintenanceRuntimeAssetsReset: true,
      runtimeAssetResetProtocol: 'cardbush.runtime_asset_reset.v1', runtimeAssetResetCategories: ['prompts', 'skills', 'agent_profiles', 'teams'], subagents: false };
    settingsProps.onRuntimeAssetsReloaded = async categories => { maintenanceReloads.push(categories); };
    renderSettings();
  `);
  await click('数据与维护');
  await until("document.querySelectorAll('.runtime-asset-category-grid input').length === 2 && !document.querySelector('.runtime-asset-reset-actions button').disabled");
  await run("document.querySelector('.runtime-asset-reset-panel').closest('details').open = true; document.querySelector('.runtime-asset-paths').open = true");
  assert.deepEqual(await run("Array.from(document.querySelectorAll('.runtime-asset-category-grid strong')).map(node => node.textContent)"), ['Prompts', 'Skills']);
  assert.doesNotMatch(await run('document.body.innerText'), /\bTeams\b|Agent Profiles|legacy\/team|legacy\/profiles/);
  assert.equal(await run("!!document.querySelector('.runtime-asset-restart-required')"), false, 'Plugin-only cached reset results must not block bundled maintenance.');
  const widths = await run("Array.from(document.querySelectorAll('.runtime-asset-category-grid label')).map(node => { const box = node.getBoundingClientRect(); return { width: box.width, top: box.top }; })");
  assert.ok(Math.abs(widths[0].width - widths[1].width) <= 1);
  assert.equal(widths[0].top, widths[1].top);
  await run("document.querySelector('.runtime-asset-reset-actions button').click()");
  assert.equal(await run("maintenanceCommands.filter(command => command.kind.endsWith('.reset')).length"), 0);
  assert.equal(await run('maintenanceConfirmations.length'), 1);
  await run("allowMaintenance = true; document.querySelector('.runtime-asset-reset-actions button').click()");
  await until("maintenanceReloads.length === 1 && !document.querySelector('.runtime-asset-reset-actions button').disabled");
  assert.deepEqual(await run("maintenanceCommands.filter(command => command.kind.endsWith('.reset')).map(command => command.categories)"), [['prompts', 'skills']]);
  assert.deepEqual(await run('maintenanceReloads'), [['prompts', 'skills']]);
  assert.doesNotMatch(await run('document.body.innerText'), /\bTeams\b|Agent Profiles/);
  fs.writeFileSync(path.join(root, 'tmp/settings-maintenance-dark.png'), (await win.webContents.capturePage()).toPNG());

  await run("document.querySelector('.runtime-asset-category-grid input').click()");
  assert.deepEqual(await run("Array.from(document.querySelectorAll('.runtime-asset-category-grid input')).map(node => node.checked)"), [false, true]);
  await click('个性化');
  await until("!document.querySelector('.runtime-asset-reset-panel')");
  await run("localStorage.setItem('cardbush_pending_runtime_asset_reset', JSON.stringify({ ...legacyReset, selectedCategories: ['skills', 'teams'], categories: { ...legacyReset.categories, skills: { restoredFileCount: 2 } } }))");
  await click('数据与维护');
  await until("!!document.querySelector('.runtime-asset-restart-required')");
  assert.deepEqual(await run("Array.from(document.querySelectorAll('.runtime-asset-reset-result b')).map(node => node.textContent)"), ['Skills']);
  assert.doesNotMatch(await run('document.body.innerText'), /\bTeams\b|Agent Profiles/);

  await run("settingsProps.language = 'en'; settingsTheme = 'bright'; renderSettings()");
  win.setContentSize(760, 850);
  await until("document.body.innerText.includes('Restore bundled runtime assets')");
  await run("document.querySelector('.runtime-asset-reset-panel').closest('details').open = true");
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.doesNotMatch(await run('document.body.innerText'), /\bTeams\b|Agent Profiles/);
  assert.equal(await run("document.querySelector('.runtime-asset-category-grid').scrollWidth <= document.querySelector('.runtime-asset-category-grid').clientWidth + 1"), true);
  fs.writeFileSync(path.join(root, 'tmp/settings-maintenance-light-narrow.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1200, 850);
  console.log('Settings maintenance passed: bundled categories only, legacy plan/cache filtering, isolated selection, confirmed reset and responsive bilingual UI.');
};
