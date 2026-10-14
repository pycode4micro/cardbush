import { extractFile, listPackage, uncache } from '@electron/asar';
import { isBuiltin } from 'node:module';
import { normalize } from 'node:path';
import ts from 'typescript';

function runtimeImports(code, file) {
  const imports = new Set();
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const add = node => {
    if (node && ts.isStringLiteralLike(node)) imports.add(node.text);
  };
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === 'require')) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...imports].filter(name => !name.startsWith('.') && !name.startsWith('/') &&
    !isBuiltin(name) && !['electron', 'original-fs'].includes(name));
}

// A structurally valid MSIX can still contain an unusable ASAR when a builder
// hook accidentally disables dependency collection. Check the installed tree.
export function verifyPackagedDependencies(archive) {
  uncache(archive);
  const files = new Set(listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, '')));
  const manifest = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  const missing = Object.keys(manifest.dependencies ?? {})
    .filter(name => !files.has(`node_modules/${name}/package.json`));
  // sharp is a required transitive native dependency used by Computer Use.
  if (!files.has('node_modules/sharp/package.json')) missing.push('sharp');
  if (!files.has('node_modules/quickjs-emscripten/package.json') || ![...files].some(file => file.includes('@jitl/quickjs-wasmfile-release-sync/') && file.endsWith('.wasm'))) missing.push('quickjs-emscripten (including WASM runtime)');
  if (missing.length) throw Error('Packaged application is missing production dependencies: ' + missing.join(', '));
  const undeclared = new Set();
  for (const file of files) {
    if (!file.startsWith('dist-electron/') || !/\.[cm]?js$/.test(file)) continue;
    for (const specifier of runtimeImports(extractFile(archive, normalize(file)).toString('utf8'), file)) {
      const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
      if (!Object.hasOwn(manifest.dependencies ?? {}, name)) undeclared.add(`${name} (${file})`);
    }
  }
  if (undeclared.size) throw Error('Packaged host imports undeclared production dependencies: ' + [...undeclared].join(', '));
  return { verified: Object.keys(manifest.dependencies ?? {}).length };
}
