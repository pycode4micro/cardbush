import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { installProductPlugin, loadProductPluginCatalog } from '../dist-electron/productPlugins.js';
const require = createRequire(import.meta.url);
const fs = require('node:fs/promises');
const root = await fs.mkdtemp(join(tmpdir(), 'cardbush-plugin-transaction-'));
const source = join(root, 'source', 'fixture-plugin-1.0.0');
const installedRoot = join(root, 'installed');
const target = join(installedRoot, 'fixture-plugin');
const originalRename = fs.rename;
const originalRm = fs.rm;
const originalCp = fs.cp;
try {
  await fs.mkdir(join(source,'.codex-plugin'),{recursive:true});
  await fs.writeFile(join(source,'.codex-plugin','plugin.json'),JSON.stringify({name:'fixture-plugin',version:'1.0.0',description:'Fixture',author:{name:'Fixture'},
    interface:{displayName:'Fixture',category:'Tests',logo:'logo.svg'}}));
  await fs.writeFile(join(source,'logo.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fs.writeFile(join(source,'payload.txt'),'old');
  const installed = await installProductPlugin(source,installedRoot);
  assert.equal(installed.id, 'fixture-plugin');
  assert.equal(installed.manifestPath, join(target, '.codex-plugin', 'plugin.json'));
  assert.equal((await fs.readdir(installedRoot)).includes('fixture-plugin-1.0.0'), false);
  await fs.writeFile(join(source,'payload.txt'),'new');
  let failCommit=true;
  fs.rename=async(from,to)=>{
    if (failCommit && resolve(to)===resolve(target) && String(from).includes(`${require('node:path').sep}staged${require('node:path').sep}`)) {
      failCommit=false;
      throw Object.assign(new Error('Injected commit failure'),{code:'EACCES'});
    }
    return originalRename(from,to);
  };
  await assert.rejects(installProductPlugin(source,installedRoot),/Injected commit failure/);
  assert.equal(await fs.readFile(join(target,'payload.txt'),'utf8'),'old','failed replacement restores previous plugin');
  fs.rename=originalRename;
  await Promise.all([installProductPlugin(source,installedRoot),installProductPlugin(source,installedRoot)]);
  assert.equal(await fs.readFile(join(target,'payload.txt'),'utf8'),'new');
  assert.deepEqual((await loadProductPluginCatalog([{path:installedRoot,source:'user'}])).map(p=>p.id),['fixture-plugin']);
  assert.equal((await fs.readdir(root)).some(name=>name.startsWith('.cardbush-plugin-install-')),false,'successful rollback/commit cleans staging');
  await assert.rejects(installProductPlugin(source,join(source,'nested')),/inside its source/);
  fs.cp = async (from, to, options) => {
    await originalCp(from, to, options);
    const manifestPath = join(to, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, name: 'changed-during-copy' }));
  };
  await assert.rejects(installProductPlugin(source, installedRoot), /manifest.*changed/i);
  fs.cp = originalCp;
  assert.deepEqual((await loadProductPluginCatalog([{path:installedRoot,source:'user'}])).map(p=>p.id),['fixture-plugin']);
  fs.rm=async(candidate,options)=>{
    if(String(candidate).includes('.cardbush-plugin-install-')) throw Object.assign(new Error('Injected old file lock'),{code:'EBUSY'});
    return originalRm(candidate,options);
  };
  await installProductPlugin(source,installedRoot);
  assert.equal(await fs.readFile(join(target,'payload.txt'),'utf8'),'new','cleanup failure must not report the committed update as failed');
  fs.rm=originalRm;
  console.log('Plugin installation: versioned source folders, manifest identity, rollback, concurrent replacement, catalog integrity, staging cleanup and recursive-copy rejection passed.');
} finally {
  fs.rename=originalRename;
  fs.rm=originalRm;
  fs.cp=originalCp;
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-plugin-transaction-'));
  await fs.rm(root,{recursive:true,force:true});
}
