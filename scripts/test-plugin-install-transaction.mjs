import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { installProductPlugin, loadProductPluginCatalog } from '../dist-electron/productPlugins.js';
const require = createRequire(import.meta.url);
const fs = require('node:fs/promises');
const root = await fs.mkdtemp(join(tmpdir(), 'cardbush-plugin-transaction-'));
const source = join(root, 'source', 'fixture-plugin');
const installedRoot = join(root, 'installed');
const target = join(installedRoot, 'fixture-plugin');
const originalRename = fs.rename;
const originalRm = fs.rm;
try {
  await fs.mkdir(join(source,'.codex-plugin'),{recursive:true});
  await fs.writeFile(join(source,'.codex-plugin','plugin.json'),JSON.stringify({name:'fixture-plugin',version:'1.0.0',description:'Fixture',author:{name:'Fixture'},
    interface:{displayName:'Fixture',category:'Tests',logo:'logo.svg'}}));
  await fs.writeFile(join(source,'logo.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fs.writeFile(join(source,'payload.txt'),'old');
  await installProductPlugin(source,installedRoot);
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
  fs.rm=async(candidate,options)=>{
    if(String(candidate).includes('.cardbush-plugin-install-')) throw Object.assign(new Error('Injected old file lock'),{code:'EBUSY'});
    return originalRm(candidate,options);
  };
  await installProductPlugin(source,installedRoot);
  assert.equal(await fs.readFile(join(target,'payload.txt'),'utf8'),'new','cleanup failure must not report the committed update as failed');
  fs.rm=originalRm;
  console.log('Plugin installation: rollback on commit failure, concurrent replacement, catalog integrity, staging cleanup and recursive-copy rejection passed.');
} finally {
  fs.rename=originalRename;
  fs.rm=originalRm;
  await fs.rm(root,{recursive:true,force:true});
}
