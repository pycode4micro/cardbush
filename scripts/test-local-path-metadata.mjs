import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const sourcePath = path.join(process.cwd(), 'src', 'backend', 'localPathMetadata.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});

const module = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  URL,
  module,
  exports: module.exports,
});

const {
  applyAllowedResourcePathsToMetadata,
  collectAllowedResourcePaths,
  localPathParent,
} = module.exports;

const pastedImage =
  'C:\\Users\\wfang\\Pictures\\cardbush-images\\image.png-2026-06-11_10-28-34-918.png';

assert.equal(
  localPathParent(pastedImage),
  'C:\\Users\\wfang\\Pictures\\cardbush-images',
);
assert.equal(
  localPathParent('file:///C:/Users/wfang/Pictures/cardbush-images/a%20b.png'),
  '/C:/Users/wfang/Pictures/cardbush-images',
);

assertJsonEqual(
  collectAllowedResourcePaths({
    projectDir: 'C:\\Users\\wfang\\Desktop\\cardbush-electron',
    images: [{ path: pastedImage }],
    files: [
      'C:\\Users\\wfang\\Desktop\\cardbush-electron\\README.md',
      pastedImage,
    ],
  }),
  [
    'C:\\Users\\wfang\\Desktop\\cardbush-electron',
    'C:\\Users\\wfang\\Pictures\\cardbush-images',
  ],
);

const metadata = {};
applyAllowedResourcePathsToMetadata(metadata, {
  images: [{ path: pastedImage }],
});
assertJsonEqual(metadata, {
  image_allowed_paths: ['C:\\Users\\wfang\\Pictures\\cardbush-images'],
  imageAllowedPaths: ['C:\\Users\\wfang\\Pictures\\cardbush-images'],
  _resource_manager_allowed_paths: ['C:\\Users\\wfang\\Pictures\\cardbush-images'],
  resourceManagerAllowedPaths: ['C:\\Users\\wfang\\Pictures\\cardbush-images'],
});

console.log('local path metadata tests passed');

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}
