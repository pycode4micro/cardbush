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

const fileReferenceSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chatMessages', 'fileReferences.ts'),
  'utf8',
);
const fileReferenceTranspiled = ts.transpileModule(fileReferenceSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const fileReferenceModule = { exports: {} };
vm.runInNewContext(fileReferenceTranspiled.outputText, {
  URL,
  module: fileReferenceModule,
  exports: fileReferenceModule.exports,
  require: () => ({
    basename: (value) => value.replaceAll('\\', '/').split('/').pop() || value,
    isAbsoluteLocalPath: (value) =>
      /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/'),
    stripWrappingQuotes: (value) => value.trim().replace(/^(['"`])([\s\S]*)\1$/, '$2'),
  }),
});
const {
  linkifyLocalFileReferences,
  localFileReference,
  localFileReferenceFromHref,
  localFileReferenceHref,
} = fileReferenceModule.exports;
const absoluteDocument = 'C:\\Users\\wfang\\Documents\\report.docx';
assert.equal(localFileReference(absoluteDocument)?.path, absoluteDocument);
assert.equal(localFileReference('/work/reports/report.xlsx')?.path, '/work/reports/report.xlsx');
assert.equal(
  localFileReference('src/App.tsx', 'D:\\proj\\cardbush'),
  null,
  'Workspace-relative paths must remain plain Markdown text',
);
assert.equal(
  localFileReferenceFromHref(localFileReferenceHref('src/App.tsx')),
  '',
  'Internal file hrefs must not allow relative paths to bypass local-path validation',
);
const linkedReferences = linkifyLocalFileReferences(
  `Open src/App.tsx and ${absoluteDocument}`,
  'D:\\proj\\cardbush',
);
assert.ok(linkedReferences.includes('src/App.tsx'));
assert.ok(!linkedReferences.includes('[App.tsx]'));
assert.ok(linkedReferences.includes('[report.docx](cardbush-local-file:'));

const stylesSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'styles', 'app.css'),
  'utf8',
);
const localFileStyle = stylesSource.match(/\.local-file-reference\s*\{([^}]*)\}/)?.[1] ?? '';
assert.ok(!/border-bottom|text-decoration:\s*(?:underline|dotted|dashed)/.test(localFileStyle));

console.log('local path metadata tests passed');

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}
