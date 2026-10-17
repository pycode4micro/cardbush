import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { creationCanvasSchema, emptyCanvas } from '@cardbush/bush-protocol';

const source = await readFile(new URL('../src/features/creationCanvas/canvasGeometry.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { adjustCanvasFrame: adjust, fitCanvasViewport, zoomCanvasPan } = await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'));
const frame = { x: 100, y: 100, width: 200, height: 140 }, bounds = { width: 1000, height: 800 };

test('fit shares a stable title edge across wide, tall and narrow viewports', () => {
  const board = { width: 1440, height: 960 };
  for (const view of [{ width: 1200, height: 720 }, { width: 900, height: 1000 }, { width: 520, height: 550 }]) {
    const inset = view.width < 600 ? 10 : 14, fit = fitCanvasViewport(view, board, inset);
    assert.deepEqual(fit.origin, { x: inset, y: 40 });
    assert.ok(fit.origin.x + board.width * fit.zoom <= view.width - inset + 1e-9);
    assert.ok(fit.origin.y + board.height * fit.zoom <= view.height - 40 + 1e-9);
  }
});

test('movement stays inside the board without changing size at either boundary', () => {
  assert.deepEqual(adjust({ frame, bounds, dx: -1000, dy: 1000 }).frame, { ...frame, x: 0, y: 660 });
  assert.deepEqual(adjust({ frame, bounds, dx: 1000, dy: -1000 }).frame, { ...frame, x: 800, y: 0 });
});

test('all eight resize handles keep the opposite edges anchored', () => {
  const expected = {
    nw: { x: 120, y: 130, width: 180, height: 110 }, n: { x: 100, y: 130, width: 200, height: 110 },
    ne: { x: 100, y: 130, width: 220, height: 110 }, e: { x: 100, y: 100, width: 220, height: 140 },
    se: { x: 100, y: 100, width: 220, height: 170 }, s: { x: 100, y: 100, width: 200, height: 170 },
    sw: { x: 120, y: 100, width: 180, height: 170 }, w: { x: 120, y: 100, width: 180, height: 140 },
  };
  for (const [handle, result] of Object.entries(expected)) assert.deepEqual(adjust({ frame, bounds, handle, dx: 20, dy: 30, snap: false }).frame, result, handle);
});

test('resizing clamps to minimum size, board edges, and the manifest size limit', () => {
  assert.deepEqual(adjust({ frame, bounds, handle: 'nw', dx: 999, dy: 999 }).frame, { x: 220, y: 180, width: 80, height: 60 });
  assert.deepEqual(adjust({ frame, bounds, handle: 'nw', dx: -999, dy: -999 }).frame, { x: 0, y: 0, width: 300, height: 240 });
  assert.deepEqual(adjust({ frame, bounds, handle: 'se', dx: 999, dy: 999 }).frame, { x: 100, y: 100, width: 900, height: 700 });
  assert.deepEqual(adjust({ frame, bounds: { width: 50000, height: 50000 }, handle: 'se', dx: 49999, dy: 49999 }).frame, { x: 100, y: 100, width: 10000, height: 10000 });
});

test('edge and centre snapping has a six-screen-pixel tolerance at 25%, 50%, 100% and 200%', () => {
  const peers = [{ x: 400, y: 470, width: 180, height: 100 }];
  for (const zoom of [.25, .5, 1, 2]) {
    const near = adjust({ frame, bounds, peers, dx: 100 - 5 / zoom, dy: 0, zoom });
    assert.equal(near.frame.x + near.frame.width, 400, `edge at ${zoom}`);
    assert.ok(near.guides.some(guide => guide.axis === 'x' && guide.position === 400));
    const far = adjust({ frame, bounds, peers, dx: 100 - 8 / zoom, dy: 0, zoom });
    assert.notEqual(far.frame.x + far.frame.width, 400, `outside tolerance at ${zoom}`);
  }
  const centred = adjust({ frame, bounds, dx: 295, dy: 0 });
  assert.equal(centred.frame.x + centred.frame.width / 2, bounds.width / 2);
});

test('snapping is optional and never moves the opposite side of a resized frame', () => {
  const peers = [{ x: 400, y: 470, width: 180, height: 100 }];
  const snapped = adjust({ frame, bounds, peers, handle: 'e', dx: 96, dy: 0 });
  assert.deepEqual(snapped.frame, { ...frame, width: 300 });
  const precise = adjust({ frame, bounds, peers, handle: 'e', dx: 96, dy: 0, snap: false });
  assert.deepEqual(precise.frame, { ...frame, width: 296 }); assert.deepEqual(precise.guides, []);
  const west = adjust({ frame, bounds, peers: [{ x: 30, y: 450, width: 100, height: 200 }], handle: 'w', dx: 27, dy: 0 });
  assert.deepEqual(west.frame, { ...frame, x: 130, width: 170 });
});

test('snap candidates cannot produce an invalid manifest even near size limits or at extreme zoom', () => {
  for (const handle of [undefined, 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    for (const zoom of [.02, .51, 2]) for (const [dx, dy] of [[-10000, -10000], [10000, 10000], [122, 82], [0, 0]]) {
      const result = adjust({ frame, bounds, handle, dx, dy, zoom, peers: [{ x: 226, y: 186, width: 300, height: 300 }] });
      creationCanvasSchema.parse({ ...emptyCanvas(), ...bounds, items: [{ id: 'item', kind: 'markdown', title: '', markdown: '', frame: result.frame }] });
    }
  }
});

test('zoom preserves the board coordinate under the cursor and is reversible after panning', () => {
  const pan = { x: 173, y: -81 }, anchor = { x: -125, y: 248 }, from = .51, to = 1.1;
  const next = zoomCanvasPan(pan, from, to, anchor);
  for (const axis of ['x', 'y']) assert.ok(Math.abs((anchor[axis] - next[axis]) / to - (anchor[axis] - pan[axis]) / from) < 1e-9);
  const returned = zoomCanvasPan(next, to, from, anchor);
  assert.ok(Math.abs(returned.x - pan.x) < 1e-9); assert.ok(Math.abs(returned.y - pan.y) < 1e-9);
});
