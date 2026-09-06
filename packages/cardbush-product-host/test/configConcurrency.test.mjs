import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardbushAppsConfigStore, ProductMcpConfigStore, ProductModelConfigStore, ProductSubagentConfigStore } from '../dist/index.js';

test('concurrent config calls serialize across instances and preserve revisions/credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-config-race-'));
  try {
    const path = join(root, 'mcp.json');
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      new ProductMcpConfigStore(path).write({ servers: [{ id: `server-${index}` }] })));
    assert.equal(results.filter(result => result.status === 'rejected').length, 0, 'no colliding temp files');
    assert.deepEqual(results.map(result => result.value.revision), Array.from({length:12},(_,i)=>i+2));
    assert.equal((await new ProductMcpConfigStore(path).read()).servers[0].id, 'server-11');
    const appsPath=join(root,'apps.json');
    const appWrites=await Promise.all(Array.from({length:8},(_,i)=>new CardbushAppsConfigStore(appsPath).write({serviceEnabled:i%2===0,plugins:[]})));
    assert.deepEqual(appWrites.map(value=>value.revision),[2,3,4,5,6,7,8,9]);
    const modelPath=join(root,'models.json');
    const base={id:'fixture',provider:'openai',model:'fixture'};
    await Promise.all([
      new ProductModelConfigStore(modelPath).write({models:[{...base,apiKey:'fixture-secret'}]}),
      new ProductModelConfigStore(modelPath).write({models:[{...base,apiKey:''}]}),
    ]);
    assert.equal((await new ProductModelConfigStore(modelPath).read()).models[0].apiKey,'fixture-secret');
    await assert.rejects(new ProductMcpConfigStore(path).write({servers:'invalid'}));
    assert.equal((await new ProductMcpConfigStore(path).write({servers:[]})).revision,14,'failure does not poison queue');
    await Promise.all(Array.from({length:12},()=>new ProductSubagentConfigStore(join(root,'subagents.json')).read()));
    assert.equal((await readdir(root)).some(name=>name.endsWith('.tmp')),false);
  } finally { await rm(root,{recursive:true,force:true}); }
});
