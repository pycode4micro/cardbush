import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import library from '../assets/skills/cardbush-docs/scripts/home-library.cjs';
import './coding-benchmark/register-loader.mjs';

const p = await import('../src/features/inspector/panelLayout.ts');
const b = await import('../src/features/inspector/browserBookmarks.ts');
const c = await import('../src/features/components/componentModel.ts');
const { dispatchComponentMessage } = await import('../src/features/components/dispatchComponentMessage.ts');
function assertPartition(tree) {
  const rects = Object.values(p.panelRects(tree));
  assert.ok(Math.abs(rects.reduce((sum, rect) => sum + rect.width * rect.height, 0) - 1) < 1e-9);
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i]; assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.width <= 1.000001 && a.y + a.height <= 1.000001);
    for (const bb of rects.slice(i + 1)) assert.ok(Math.min(a.x + a.width, bb.x + bb.width) - Math.max(a.x, bb.x) <= 1e-9 || Math.min(a.y + a.height, bb.y + bb.height) - Math.max(a.y, bb.y) <= 1e-9, 'pages must never overlap');
  }
}
test('two pages start at half the available area, repeated opens preserve identity', () => {
  const tree = p.addPanel(p.addPanel(null, 'a'), 'b');
  assert.deepEqual(p.panelRects(tree), { a: { x: 0, y: 0, width: .5, height: 1 }, b: { x: .5, y: 0, width: .5, height: 1 } });
  assert.equal(p.addPanel(tree, 'b'), tree); assertPartition(tree);
});
test('adding, resizing, swapping and removing preserve a complete non-overlapping partition', () => {
  let tree = null;
  for (let i = 0; i < 12; i++) { tree = p.addPanel(tree, String(i)); assertPartition(tree); }
  for (const divider of p.panelDividers(tree)) { tree = p.resizePanelSplit(tree, divider.path, .33); assertPartition(tree); }
  const before = p.panelRects(tree); tree = p.swapPanels(tree, '0', '11');
  assert.deepEqual(p.panelRects(tree)['0'], before['11']); assertPartition(tree);
  tree = p.retainPanels(tree, new Set(['1','5','11'])); assert.equal(p.panelIds(tree).length, 3); assertPartition(tree);
  assert.equal(p.retainPanels(tree, new Set()), null);
  assert.deepEqual(p.resizePanelSplit(tree, '', NaN), tree);
});
test('bookmarks keep distinct URLs but reject executable, credential and duplicate URLs', () => {
  assert.deepEqual(b.normalizeBookmarks([{url:'https://example.com',title:' A '},{url:'https://example.com/'},{url:'javascript:alert(1)'},{url:'file:///C:/x'},{url:'https://u:p@example.com/'},{url:'https://example.com/?q=2'}]), [
    { id:'https://example.com/',url:'https://example.com/',title:'A' }, { id:'https://example.com/?q=2',url:'https://example.com/?q=2',title:'example.com' },
  ]);
});
test('component imports bound executable document size, layout, identity and explicit grants', () => {
  const valid = {id:'example',html:'<h1>Hello</h1>',title:' Hello ',width:999,height:1,allowActions:'true'};
  const value = c.normalizeComponents({version:1,revision:4,items:[valid,valid,{...valid,id:'../foreign'},{...valid,id:'large',html:'界'.repeat(c.maxComponentBytes)}]});
  const custom = value.items;
  assert.equal(custom.length,1); assert.equal(custom[0].width,12); assert.equal(custom[0].height,120); assert.equal(custom[0].allowActions,false);
  assert.throws(()=>c.validateComponentText(' ')); assert.throws(()=>c.validateComponentText('x'.repeat(32001))); assert.equal(c.validateComponentText('hello'),'hello');
});

test('only custom components survive migration; previously placed custom content moves to home', () => {
  const items = [{id:'system-clock',kind:'builtin'}, {id:'draft',html:'<p>Draft</p>'}, {id:'placed',html:'<p>Shown</p>'}];
  const result = c.normalizeComponents({version:1, items, welcomeLayout:{items:[{componentId:'placed'}]}});
  assert.deepEqual(result.items.map(({id,home})=>[id,home]), [['draft',false],['placed',true]]);
  assert.equal(c.defaultComponents.items.length,0);
});

test('component dispatch acknowledges locally without waiting for a long model turn, rejects unavailable configuration', async () => {
  let sent = 0, failure;
  const pending = new Promise(() => {});
  const host = { ready: true, model: 'model', send: () => { sent++; return pending; }, onError: error => { failure = error; } };
  await dispatchComponentMessage('hello', host);
  assert.equal(sent, 1);
  await assert.rejects(dispatchComponentMessage('hello', { ...host, ready: false }), /RUNTIME_NOT_READY/);
  await assert.rejects(dispatchComponentMessage('hello', { ...host, model: '' }), /MODEL_REQUIRED/);
  assert.equal(sent, 1);
  await dispatchComponentMessage('hello', { ...host, send: async () => { throw new Error('backend failure'); } });
  await Promise.resolve();
  assert.equal(failure.message, 'backend failure');
});

test('desktop and chat edits share a durable revision and migrate legacy content once', () => {
  const profile = mkdtempSync(join(tmpdir(), 'cardbush-home-test-'));
  const editor = library.openLibrary(profile), agent = library.openLibrary(profile);
  const sample = {id:'checklist',title:'Checklist',html:'<p>Checklist</p>',width:6,height:280};
  try {
    const first = agent.publish(sample,true);
    const old = {...sample,id:'legacy',order:1,home:false,allowActions:true};
    const migrated = editor.migrate([old]);
    assert.deepEqual(migrated.items.map(item=>item.id), ['checklist','legacy']);
    assert.throws(()=>editor.save([],first.revision),/REVISION_CONFLICT/);
    const updated = agent.publish({...sample,id:'legacy',html:'<p>Updated</p>'},undefined);
    assert.equal(updated.items[1].allowActions,false);
    editor.save(updated.items.filter(item=>item.id!=='legacy'),updated.revision);
    assert.equal(agent.migrate([old]).items.length,1);
    const reopened = library.openLibrary(profile);
    try { assert.equal(reopened.snapshot().items[0].home,true); } finally { reopened.close(); }
  } finally { agent.close(); editor.close(); rmSync(profile,{recursive:true,force:true}); }
});

test('declared component websites load without another grant and legacy defaults remain scoped', () => {
  const profile = mkdtempSync(join(tmpdir(), 'cardbush-home-website-'));
  const db = library.openLibrary(profile);
  const site = 'https://media.example.org', url = site+'/directory?q=live#now';
  const source = {id:'site',title:'Media',html:'<p>Preview</p>',embedDomains:[site]};
  try {
    const state = db.publish({...source,homeWebsiteUrl:url,approvedEmbedOrigins:[site]},true);
    const card = state.items[0];
    assert.equal(card.homeWebsiteUrl,undefined);
    assert.deepEqual(c.approvedEmbedOrigins(card),[site]);
    assert.deepEqual(card.approvedEmbedOrigins,[site]);
    for (const target of ['blob:'+url,'https://another.example.org/', 'https://user@media.example.org/']) {
      assert.throws(()=>db.save([{...card,approvedEmbedOrigins:[site],homeWebsiteUrl:target}],state.revision),/INVALID_COMPONENT_WEBSITE/);
    }
    db.save([{...card,approvedEmbedOrigins:[site],homeWebsiteUrl:url}],state.revision);
    assert.equal(db.publish({...source,title:'Renamed',homeWebsiteUrl:null}).items[0].homeWebsiteUrl,url);
    assert.equal(db.publish({...source,embedDomains:[]}).items[0].homeWebsiteUrl,undefined);
    const again = db.publish(source);
    db.save([{...again.items[0],approvedEmbedOrigins:[site],homeWebsiteUrl:url}],again.revision);
    const updated = db.publish({...source,html:'<p>Changed</p>'}).items[0];
    assert.equal(updated.homeWebsiteUrl,undefined);
    assert.deepEqual(updated.approvedEmbedOrigins,[site]);
    assert.deepEqual(c.approvedEmbedOrigins({...updated,approvedEmbedOrigins:[]}),[site],'old approval records do not add another gate');
    assert.deepEqual(c.approvedEmbedOrigins({...updated,embedDomains:[]}),[],'only declared sites are allowed');
  } finally { db.close(); rmSync(profile,{recursive:true,force:true}); }
});

test('component browser geometry stays inside its component and URLs stay within declarations', async () => {
  const {componentBrowsers}=await import('../src/features/components/componentBrowsers.ts');
  const site='https://media.example.org', slot={id:'browser-1',url:site+'/watch',revision:0,x:-10,y:20,width:300,height:200,
    clipX:-10,clipY:20,clipWidth:300,clipHeight:200};
  assert.deepEqual(componentBrowsers([slot],[site],250,150),[{...slot,clipX:0,clipY:20,clipWidth:250,clipHeight:130}]);
  for(const url of ['file:///tmp/private','https://other.example.org/','https://u:p@media.example.org/'])
    assert.deepEqual(componentBrowsers([{...slot,url}],[site],250,150),[]);
  assert.deepEqual(componentBrowsers([slot],[],250,150),[]);
  assert.deepEqual(componentBrowsers([{...slot,width:Infinity}],[site],250,150),[]);
  assert.deepEqual(componentBrowsers([{...slot,clipWidth:-1}],[site],250,150),[]);
  assert.equal(componentBrowsers([slot,slot],[site],250,150).length,1);
});
