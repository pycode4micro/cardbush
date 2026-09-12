import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'team-plugin-ui-'));
const local = path => resolve(path).replaceAll('\\', '/');
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TeamPluginWorkspace } from '${local('packages/cardbush-team-plugin/ui/TeamPluginWorkspace.tsx')}';
import { teamWorkspaceActions, useTeamWorkspaceState } from '${local('packages/cardbush-team-plugin/ui/teamWorkspaceStore.ts')}';
import { defaultTeamConfiguration } from '@cardbush/team-plugin/configuration';
import '${local('src/styles/app.css')}';
import '${local('src/styles/theme.css')}';
import '${local('src/styles/themes/cyberpunk.css')}';
window.receipt = { path: 'C:/Fixture/teams.json', contentHash: '1', configuration: defaultTeamConfiguration() };
window.saves = []; window.exports = []; window.reveals = 0;
window.cardbushDesktop = { teamConfiguration: async input => {
  if(input.action === 'import') return window.importValue ?? null;
  if(input.action === 'export') { window.exports.push(structuredClone(input)); return 'C:/Fixture/export.yaml'; }
  if(input.action === 'reveal') { window.reveals++; return receipt.path; }
} };
window.actions = teamWorkspaceActions;
function Fixture() {
  window.teamState = useTeamWorkspaceState();
  return <div className="app theme-cyberpunk" style={{height:'100vh', display:'flex', padding:12, boxSizing:'border-box'}}><TeamPluginWorkspace language="zh"/></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
try {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'team-plugin-fixture', enforce: 'pre',
    resolveId(id, importer) {
      if (id.endsWith('__team_plugin_fixture__.tsx')) return '\0team-plugin-fixture.tsx';
      if (id === './host' && importer?.endsWith('teamWorkspaceStore.ts')) return '\0team-plugin-fixture-host';
      if (id === './api' && importer?.endsWith('teamWorkspaceStore.ts')) return '\0team-plugin-fixture-api';
    },
    load(id) {
      if (id === '\0team-plugin-fixture.tsx') return source;
      if (id === '\0team-plugin-fixture-host') return 'export const teamConfiguration = input => window.cardbushDesktop.teamConfiguration(input);';
      if (id === '\0team-plugin-fixture-api') return `
        export async function fetchTeamWorkspace(){ return structuredClone(window.receipt); }
        export async function fetchTeamConfigurationCapabilities(){ return {available:true}; }
        export async function saveTeamWorkspace(input){
          const submitted=structuredClone(input); window.saves.push(submitted);
          if(window.deferSave) await new Promise(resolve=>window.finishSave=resolve);
          if(submitted.expectedHash!==window.receipt.contentHash) throw Error('Team configuration changed on disk. Refresh before saving.');
          window.receipt={...window.receipt,contentHash:String(Number(window.receipt.contentHash)+1),configuration:{protocol:'cardbush.team_configuration.v1',teams:submitted.teams,profiles:submitted.profiles}};
          return structuredClone(window.receipt);
        }
        export async function deleteTeamDefinition(id,expectedHash){ return saveTeamWorkspace({...window.receipt.configuration,teams:window.receipt.configuration.teams.filter(team=>team.id!==id),expectedHash}); }
        export async function deleteAgentProfile(id,expectedHash){ return saveTeamWorkspace({...window.receipt.configuration,profiles:window.receipt.configuration.profiles.filter(profile=>profile.id!==id),expectedHash}); }
      `;
    },
  }], build: { outDir: directory, emptyOutDir: true, minify: false, lib: { entry: resolve('__team_plugin_fixture__.tsx'), formats: ['iife'], name: 'TeamFixture' } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  const styles = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${styles.map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-team-plugin-ui-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 35000 });
  assert.equal(run.status, 0, String(run.error ?? 'Team UI fixture failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'team-plugin-ui-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
