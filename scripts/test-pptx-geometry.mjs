import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { patchedPptxWorker } from './pptx-worker-plugin.mjs';

const catalog = JSON.parse(fs.readFileSync('src/office/presetShapes.json', 'utf8'));
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/office/drawingmlGeometry.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText, { exports, require: () => catalog });
const { presetGeometry, nativePresetMarkup, evaluateGuide } = exports;

test('all 187 presets evaluate finite paths for wide, tall and square shapes', () => {
  assert.equal(Object.keys(catalog.presets).length, 187);
  for (const name of Object.keys(catalog.presets)) for (const [w, h] of [[900, 90], [90, 900], [240, 240]]) {
    const paths = presetGeometry(name, w, h);
    if (paths == null) continue; // Connector/line marker geometry stays upstream.
    assert.ok(paths.length, name);
    for (const path of paths) {
      assert.ok(path.d.length, name);
      assert.doesNotMatch(path.d, /NaN|Infinity|undefined/, name);
    }
  }
});

test('roundRect radius comes from the shorter side and its adjustment, rather than half the width or a fixed pixel value', () => {
  const d = presetGeometry('roundRect', 900, 90, { adj: 45455 })[0].d;
  assert.match(d, /A40\.9095,40\.9095 /);
  assert.match(d, /L859\.0905,0/);
  assert.match(presetGeometry('roundRect', 90, 900, { adj: 45455 })[0].d, /A40\.9095,40\.9095 /);
  assert.match(presetGeometry('roundRect', 900, 90, { adj: 999999 })[0].d, /A45,45 /, 'oversized adjustments are clamped');
  assert.doesNotMatch(presetGeometry('roundRect', 900, 90, { adj: 0 })[0].d, /A/, 'zero means square corners');
});

test('single, paired and snipped corners use the correct independent adjustment values', () => {
  const single = presetGeometry('round1Rect', 900, 90, { adj: 25000 })[0].d;
  assert.equal((single.match(/A/g) ?? []).length, 1);
  assert.match(single, /A22\.5,22\.5 /);
  const paired = presetGeometry('round2SameRect', 900, 90, { adj1: 50000, adj2: 0 })[0].d;
  assert.equal((paired.match(/A/g) ?? []).length, 2);
  assert.match(paired, /A45,45 /);
  const snipped = presetGeometry('snipRoundRect', 900, 90, { adj1: 25000, adj2: 10000 })[0].d;
  assert.match(snipped, /A22\.5,22\.5 /);
  assert.match(snipped, /L891,0 L900,9/);
});

test('adjustment boundaries remain finite for all adjustable presets', () => {
  for (const [name, preset] of Object.entries(catalog.presets)) {
    for (const [adjustment] of preset.adjustments) for (const value of [0, 100000]) {
      const paths = presetGeometry(name, 900, 90, { [adjustment]: value });
      for (const path of paths ?? []) assert.doesNotMatch(path.d, /NaN|Infinity|undefined/, `${name} ${adjustment}=${value}`);
    }
  }
});

test('a full ellipse uses multiple arcs and a donut retains its unfilled hole', () => {
  const ellipse = presetGeometry('ellipse', 900, 90)[0].d;
  assert.equal((ellipse.match(/A450,45/g) ?? []).length, 4);
  const donut = presetGeometry('donut', 240, 240)[0].d;
  assert.equal((donut.match(/M/g) ?? []).length, 2);
  assert.match(donut, /A60,60 0 0 0/, 'the inner contour winds in the opposite direction');
});

test('native guide objects and arrays are equivalent; argument order never selects a different adjustment', () => {
  const paint = { fill: '#ffff00', stroke: 'none', width: 0, dash: '' };
  const guide = { attrs: { name: 'adj', fmla: 'val 45455' } };
  assert.equal(nativePresetMarkup('roundRect', 900, 90, guide, paint), nativePresetMarkup('roundRect', 900, 90, [guide], paint));
  const a = { attrs: { name: 'adj1', fmla: 'val 25000' } }, b = { attrs: { name: 'adj2', fmla: 'val 10000' } };
  assert.equal(nativePresetMarkup('snipRoundRect', 900, 90, [a, b], paint), nativePresetMarkup('snipRoundRect', 900, 90, [b, a], paint));
  assert.equal(nativePresetMarkup('straightConnector1', 900, 90, undefined, paint), null);
});

test('guides use DrawingML angle units and reject executable expressions', () => {
  assert.ok(Math.abs(evaluateGuide('sin 30 5400000', Number) - 30) < 1e-9);
  assert.equal(evaluateGuide('pin 0 90000 50000', Number), 50000);
  assert.throws(() => evaluateGuide('eval process.exit()', Number), /Unsupported/);
});

test('the bundled adapter replaces the preset switch once and preserves the upstream connector fallback', () => {
  const source = patchedPptxWorker(process.cwd());
  assert.equal((source.match(/var cardbushGeometry=/g) ?? []).length, 1);
  assert.match(source, /if\(cardbushGeometry!==null\)/);
  assert.match(source, /case"straightConnector1"/);
  assert.match(source, /import \{nativePresetMarkup\}/);
});
