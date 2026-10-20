import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/office/drawingmlChartCategories.ts','utf8'), {
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText,{exports});
const normalize = value => JSON.parse(JSON.stringify(exports.normalizeChartCategories(value)));
const point = (idx, value) => ({attrs:{idx:String(idx)},'c:v':value});
test('PptxGenJS multi-level category caches retain Chinese labels and original point indexes', () => {
  const points = [point(0,'文档'),point(1,'表格'),point(2,'演示'),point(3,'视频')];
  const series = {'c:cat':{'c:multiLvlStrRef':{'c:multiLvlStrCache':{'c:lvl':{'c:pt':points}}}},'c:val':{unchanged:true}};
  const before=JSON.stringify(series), result=normalize(series);
  assert.deepEqual(result['c:cat']['c:strRef']['c:strCache']['c:pt'],points);
  assert.deepEqual(result['c:val'],series['c:val']);
  assert.equal(JSON.stringify(series),before);
  const multi = normalize({'c:cat':{'c:multiLvlStrRef':{'c:multiLvlStrCache':{'c:lvl':[
    {'c:pt':[point(0,'A'),point(2,'C')]},{'c:pt':[point(0,'2026'),point(2,'2027')]},
  ]}}}});
  assert.deepEqual(multi['c:cat']['c:strRef']['c:strCache']['c:pt'],[point(0,'A / 2026'),point(2,'C / 2027')]);
});
test('literal categories normalize without changing ordinary referenced or scatter series', () => {
  for(const type of ['c:strLit','c:numLit']) {
    const points=[point(0,'0'),point(1,'3.5')];
    assert.deepEqual(normalize({'c:cat':{[type]:{'c:pt':points}}})['c:cat']['c:strRef']['c:strCache']['c:pt'],points);
  }
  const series=[{'c:cat':{'c:strRef':{}}},{'c:cat':{'c:numRef':{}}},{'c:xVal':{},'c:yVal':{}}];
  assert.deepEqual(normalize(series),series);
});
