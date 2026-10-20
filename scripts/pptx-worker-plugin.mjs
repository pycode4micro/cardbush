import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const virtualId = 'virtual:cardbush-pptx-worker';
// Keep the audited 3.0.0 parser/text/image engine. Replace its approximation of
// preset geometry at build time, without eval, CSP changes or node_modules edits.
export function patchedPptxWorker(root) {
  const file = require.resolve('@file-viewer/pptx/worker/pptx.worker.js');
  let source = fs.readFileSync(file, 'utf8');
  // Unsupported native charts used to produce an empty div with no queue item.
  // Route them through the same observable failure path as chart-library errors.
  const chartReturn = 'return u!==null&&Tg.MsgQueue.push(u),Z0++,i';
  if (source.split(chartReturn).length !== 2) throw Error('PPTX chart parser changed; review the adapter before building.');
  source = source.replace(chartReturn, 'return u===null&&(u={type:"createChart",data:{chartID:"chart"+Z0,chartType:"unsupported",chartData:[]}}),Tg.MsgQueue.push(u),Z0++,i');
  const seriesStart = 'function uo(e){';
  if (source.split(seriesStart).length !== 2) throw Error('PPTX chart series parser changed; review the adapter before building.');
  source = source.replace(seriesStart, seriesStart + 'e=normalizeChartCategories(e);');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const candidates = [];
  const walk = node => {
    if (ts.isSwitchStatement(node) && node.caseBlock.clauses.some(clause => clause.expression?.text === 'roundRect') &&
        node.caseBlock.clauses.some(clause => clause.expression?.text === 'ellipse')) candidates.push(node);
    ts.forEachChild(node, walk);
  };
  walk(tree);
  if (candidates.length !== 1) throw Error('PPTX dependency geometry changed; review the adapter before building.');
  const target = candidates[0];
  // These are private symbols in the pinned upstream worker; fail closed if its
  // surrounding paint contract changes rather than silently producing bad PPTs.
  if (target.expression.getText(tree) !== 'E' || (!source.includes('var jx=') && !source.includes('function jx('))) {
    throw Error('Unsupported PPTX worker version');
  }
  const replacement = `var cardbushGeometry=nativePresetMarkup(E,o,f,D(e,["p:spPr","a:prstGeom","a:avLst","a:gd"]),
    {fill:j?"url(#imgPtrn_"+v+")":ae?"url(#linGrd_"+v+")":V,stroke:y.color,width:y.width,dash:y.strokeDasharray});
    if(cardbushGeometry!==null){p+=cardbushGeometry;}else{${target.getText(tree)}}`;
  const modulePath = path.resolve(root, 'src/office/drawingmlGeometry.ts').replaceAll('\\', '/');
  const categoriesPath = path.resolve(root, 'src/office/drawingmlChartCategories.ts').replaceAll('\\', '/');
  return `import {nativePresetMarkup} from ${JSON.stringify(modulePath)};\nimport {normalizeChartCategories} from ${JSON.stringify(categoriesPath)};\n` +
    source.slice(0, target.getStart(tree)) + replacement + source.slice(target.end);
}

export function pptxWorkerPlugin(root) {
  return { name: 'cardbush-pptx-geometry',
    resolveId(id) { if (id === virtualId) return '\0' + virtualId; },
    load(id) { if (id === '\0' + virtualId) return patchedPptxWorker(root); },
  };
}
