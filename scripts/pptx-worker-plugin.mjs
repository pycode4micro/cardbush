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
  const source = fs.readFileSync(file, 'utf8');
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
  return `import {nativePresetMarkup} from ${JSON.stringify(modulePath)};\n` +
    source.slice(0, target.getStart(tree)) + replacement + source.slice(target.end);
}

export function pptxWorkerPlugin(root) {
  return { name: 'cardbush-pptx-geometry',
    resolveId(id) { if (id === virtualId) return '\0' + virtualId; },
    load(id) { if (id === '\0' + virtualId) return patchedPptxWorker(root); },
  };
}
