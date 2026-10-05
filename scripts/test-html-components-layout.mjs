import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
const load = file => { const exports = {}; new Function('exports', 'require', ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(exports, spec => load(path.resolve(path.dirname(file), spec + '.ts'))); return exports; };
const p = load('src/features/inspector/panelLayout.ts');
const b = load('src/features/inspector/browserBookmarks.ts');
const c = load('src/features/components/componentModel.ts');
const { dispatchComponentMessage } = load('src/features/components/dispatchComponentMessage.ts');
const g = load('src/features/components/welcomeLayoutGeometry.ts');
const composer = load('src/features/components/composerLayoutGeometry.ts');
const viewport = load('src/features/components/welcomeViewportGeometry.ts');

test('welcome layouts retain aligned proportions through maximize, restore and editor rebasing', () => {
  const layout = { viewportHeight: 700, items: [
    { componentId: 'system-calendar', x: 10, y: 140, width: 36, height: 280 },
    { componentId: 'system-digital-clock', x: 54, y: 140, width: 36, height: 280 },
    { componentId: 'system-input', x: 10, y: 560, width: 80, height: 52 },
    { componentId: 'system-brand', x: 10, y: 1000, width: 80, height: 200 },
  ] };
  const stored = c.normalizeComponents({ ...c.defaultComponents, welcomeLayout: layout }).welcomeLayout;
  assert.equal(stored.viewportHeight, 700);
  const enlarged = viewport.resolveWelcomeLayout(stored, 1050);
  assert.equal(enlarged.items[0].y, 210); assert.equal(enlarged.items[0].height, 420);
  assert.equal(enlarged.items[1].y, enlarged.items[0].y, 'aligned component edges remain aligned');
  assert.equal(enlarged.items[2].y, 840); assert.equal(enlarged.items[2].height, 52, 'input height follows its contents');
  assert.equal(enlarged.items[3].y, 1500, 'off-screen placements do not redefine the viewport');
  assert.deepEqual(viewport.resolveWelcomeLayout(enlarged, 700), layout, 'rebasing and restoring does not accumulate drift');
  for (const invalid of [undefined, 0, -10, NaN, Infinity, '700']) {
    const legacy = c.normalizeComponents({ ...c.defaultComponents, welcomeLayout: { ...layout, viewportHeight: invalid } }).welcomeLayout;
    assert.equal(legacy.viewportHeight, undefined);
    assert.deepEqual(viewport.resolveWelcomeLayout(legacy, 700).items, layout.items, 'legacy placements remain unchanged until first measured');
  }
});

test('composer is centered before storage and cannot move horizontally or resize its empty height', () => {
  const input = { componentId: 'system-input', x: 0, y: 150, width: 60, height: 52 };
  const stored = c.normalizeComponents({ ...c.defaultComponents, welcomeLayout: { items: [input] } }).welcomeLayout.items[0];
  assert.equal(stored.x, 20);
  const space = { width: 1000, height: 800, scaleX: 1.25, scaleY: 1.25 };
  const moved = g.alignPlacement(stored, [], 'move', { x: 400, y: 60 }, space, false).placement;
  assert.equal(moved.x, 20); assert.equal(moved.y, 210); assert.equal(moved.width, 60);
  const resized = g.alignPlacement(moved, [], 'resize', { x: 50, y: 500 }, space, false).placement;
  assert.equal(resized.width, 70); assert.equal(resized.x, 15); assert.equal(resized.height, 52);
  const narrow = g.alignPlacement(input, [], 'resize', { x: -500, y: 0 }, { ...space, width: 240 }).placement;
  assert.equal(narrow.width * 240 / 100, 216); assert.equal(narrow.x * 240 / 100, 12);
  const pinned = { ...stored, y: 728, composerDock: 'bottom', composerFlow: { afterSend: 'keep', output: 'above' } };
  assert.equal(g.alignPlacement(pinned, [], 'move', { x: 80, y: 0 }, space, false).placement.composerDock, 'bottom',
    'horizontal-only dragging cannot remove the vertical pin');
});

test('bottom placements snap or leave meaningful travel, including tall inputs and small windows', () => {
  for (const viewport of [300, 480, 680, 900, 1200]) for (const height of [52, 104, 240]) {
    for (const y of [12, 200, viewport - height - 70, viewport + 200]) {
      const auto = composer.composerVerticalBounds(viewport, height, y, 'bottom');
      assert.ok(auto.minimumTravel >= 120 && auto.minimumTravel <= 160);
      assert.ok(auto.bottom - auto.top === 0 || auto.bottom - auto.top >= auto.minimumTravel);
      assert.ok(auto.top >= 12 && auto.top <= auto.bottom);
      if (viewport === 300) assert.equal(auto.top, auto.bottom);
    }
  }
  const kept = composer.composerVerticalBounds(680, 52, 560, 'keep');
  assert.equal(kept.top, 560, 'keep allows a small gap without silently moving');
  const pinned = composer.composerVerticalBounds(900, 52, 560, 'bottom', true);
  assert.equal(pinned.top, 828, 'saved bottom pin follows viewport height');
  assert.equal(composer.composerHorizontalBounds(1000, 60).left, 200);
  assert.deepEqual(composer.composerHorizontalBounds(320, undefined, 218), { left: 51, width: 218 }, 'default composer fits the narrow transcript track');
  assert.deepEqual(composer.composerHorizontalBounds(1000, 90, 704, 700), { left: 12, width: 676 }, 'summary constrains width symmetrically');
});

test('composer flow defaults, validates choices and lets a placement override the catalog', () => {
  assert.deepEqual(c.welcomeComposerFlow(c.defaultComponents), { afterSend: 'bottom', output: 'above' });
  const catalog = { ...c.defaultComponents, items: c.defaultComponents.items.map(item => item.id === 'system-input'
    ? { ...item, composerFlow: { afterSend: 'keep', output: 'below' } } : item) };
  assert.deepEqual(c.welcomeComposerFlow(c.normalizeComponents(catalog)), { afterSend: 'keep', output: 'below' });
  const placed = c.normalizeComponents({ ...catalog, welcomeLayout: { items: [{ componentId: 'system-input', x: 10, y: 260, width: 80, height: 120,
    composerFlow: { afterSend: 'bottom', output: 'above' } }] } });
  assert.deepEqual(c.welcomeComposerFlow(placed), { afterSend: 'bottom', output: 'above' });
  assert.deepEqual(c.normalizeComposerFlow({ afterSend: 'invalid', output: 'invalid' }), { afterSend: 'bottom', output: 'above' });
});

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
  const custom = value.items.filter(item => !c.isBuiltinComponent(item));
  assert.equal(custom.length,1); assert.equal(custom[0].width,12); assert.equal(custom[0].height,120); assert.equal(custom[0].allowActions,false);
  assert.throws(()=>c.validateComponentText(' ')); assert.throws(()=>c.validateComponentText('x'.repeat(32001))); assert.equal(c.validateComponentText('hello'),'hello');
});

test('built-ins survive deletion and old layouts migrate without replacing custom components', () => {
  const builtinIds = c.defaultComponents.items.map(item => item.id);
  const migrated = c.normalizeComponents({version:1,revision:3,items:[{id:'old-html',title:'Old',html:'<p>Keep me</p>',width:9,height:350,order:4,allowActions:true}]});
  assert.equal(migrated.revision,3); assert.equal(migrated.items[0].html,'<p>Keep me</p>'); assert.equal(migrated.items[0].width,9);
  assert.deepEqual(migrated.items.filter(c.isBuiltinComponent).map(item=>item.id),builtinIds);
  const removed = c.normalizeComponents({...migrated,items:[]});
  assert.deepEqual(removed.items.map(item=>item.id),builtinIds,'saving a removal cannot delete a system definition');
  const altered = c.normalizeComponents({...removed,items:removed.items.map(item=>({...item,html:'<script>bad()</script>',allowActions:true,inputStyle:'simple',width:8}))});
  assert.equal(altered.items.find(item=>item.id==='system-input').inputStyle,'simple');
  assert.equal(altered.items.every(item=>!('html' in item)&&!('allowActions' in item)),true,'stored settings cannot replace a built-in renderer');
  assert.equal(c.normalizeComponents({...removed,items:[{id:123,html:'x'},null,...removed.items]}).items.length,builtinIds.length);
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

test('welcome placements are independent from the catalog, bounded and retain an intentionally empty page', () => {
  const empty = c.normalizeComponents({...c.defaultComponents,welcomeLayout:{items:[]}});
  assert.deepEqual(empty.welcomeLayout.items,[]);
  assert.equal(empty.items.length,7,'clearing the page retains all system definitions');
  const layout = c.normalizeComponents({...empty,welcomeLayout:{items:[
    {componentId:'system-clock',x:98,y:-5,width:70,height:Infinity},
    {componentId:'system-clock',x:0,y:0,width:40,height:100},
    {componentId:'deleted-custom',x:0,y:0,width:40,height:100},null,
  ]}}).welcomeLayout;
  assert.deepEqual(layout.items,[{componentId:'system-clock',x:30,y:0,width:70,height:200}]);
  assert.equal(c.normalizeComponents({...empty,welcomeLayout:undefined}).welcomeLayout,undefined,'reset to the default welcome page is distinct from clear');
});

test('layout coordinates account for scaled viewport, borders and scrolling without changing the grab offset', () => {
  const element = { getBoundingClientRect: () => ({ left: 80, top: 40, width: 1000, height: 750 }),
    offsetWidth: 800, offsetHeight: 600, clientWidth: 796, clientHeight: 596, clientLeft: 2, clientTop: 2, scrollLeft: 0, scrollTop: 170 };
  const space = g.layoutSpace(element);
  assert.deepEqual(g.layoutPoint(space, 332.5, 292.5), { x: 200, y: 370 });
  const first = g.layoutPoint(space, 332.5, 292.5), moved = g.layoutPoint({ ...space, scrollTop: 210 }, 382.5, 317.5);
  assert.deepEqual({ x: moved.x-first.x, y: moved.y-first.y }, { x: 40, y: 60 });
});

test('move and resize snap to peer edges, centers and page bounds, with screen-space tolerance and Alt escape', () => {
  const item = { componentId: 'drag', x: 10, y: 80, width: 20, height: 100 };
  const peer = { componentId: 'peer', x: 50, y: 300, width: 20, height: 100 };
  const space = { width: 1000, height: 800, scaleX: 1.25, scaleY: 1.25 };
  const moved = g.alignPlacement(item, [item, peer], 'move', { x: 396, y: 216 }, space);
  assert.equal(moved.placement.x, 50); assert.equal(moved.placement.y, 300);
  assert.ok(moved.guides.some(guide => guide.axis === 'x' && guide.position === 500));
  const free = g.alignPlacement(item, [item, peer], 'move', { x: 396, y: 216 }, space, false);
  assert.equal(free.placement.x, 49.6); assert.equal(free.placement.y, 296); assert.deepEqual(free.guides, []);
  const beyond = g.alignPlacement(item, [item, peer], 'move', { x: 395, y: 215 }, space);
  assert.equal(beyond.placement.x, 49.5, '5 CSS px exceeds 6 screen px at 125%');
  const resized = g.alignPlacement(item, [peer], 'resize', { x: 296, y: 116 }, space);
  assert.equal(resized.placement.width, 50, 'right edge aligns to peer center'); assert.equal(resized.placement.height, 220);
  assert.equal(g.alignPlacement(item, [], 'move', { x: -98, y: -78 }, space).placement.x, 0);
  assert.equal(g.alignPlacement(item, [], 'resize', { x: -5000, y: -5000 }, space).placement.width, 10);
  const far = g.alignPlacement(item, [], 'resize', { x: 5000, y: 5000 }, space).placement;
  assert.equal(far.width, 90); assert.equal(far.height, 1200);
});

test('toolbar stays inside the content area and below the app header after dragging or resizing', () => {
  assert.deepEqual(g.boundToolbar({ x: 1000, y: 900 }, { width: 800, height: 600 }, { width: 400, height: 40 }, 58), { x: 392, y: 552 });
  assert.deepEqual(g.boundToolbar({ x: -400, y: -300 }, { width: 340, height: 600 }, { width: 320, height: 40 }, 58), { x: 8, y: 58 });
});
