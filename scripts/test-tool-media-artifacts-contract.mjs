import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

function transpileCommonJs(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

function evaluateModule(source, requireModule = () => ({})) {
  const module = { exports: {} };
  vm.runInNewContext(transpileCommonJs(source), {
    console,
    JSON,
    Map,
    Number,
    module,
    exports: module.exports,
    require: requireModule,
  });
  return module.exports;
}

const localPaths = evaluateModule(read('src', 'shared', 'localPaths.ts'));
const artifactSource = read('src', 'backend', 'toolArtifacts.ts');
const artifactsModule = evaluateModule(
  artifactSource,
  (request) => request === '../shared/localPaths' ? localPaths : {},
);
const { toolArtifactsFromPayload, mergeToolArtifacts } = artifactsModule;

const structured = toolArtifactsFromPayload({
  artifacts: [{
    id: 'artifact-one',
    kind: 'image',
    path: 'C:\\workspace\\renders\\one.png',
    mime_type: 'image/png',
    size: 42,
    display: 'inline',
    read_only: true,
  }],
});
assert.equal(structured.length, 1);
assert.equal(structured[0].id, 'artifact-one');
assert.equal(structured[0].type, 'image');
assert.equal(structured[0].size, 42);

const compatibility = toolArtifactsFromPayload({
  metadata: {
    result: {
      images: [{ image_path: 'D:\\tmp\\nested.webp' }],
    },
  },
  output: 'C:\\workspace\\renders\\legacy.jpg',
});
assert.deepEqual(
  Array.from(compatibility, (artifact) => artifact.path),
  ['D:\\tmp\\nested.webp', 'C:\\workspace\\renders\\legacy.jpg'],
);

const jsonOutput = toolArtifactsFromPayload({
  output: JSON.stringify({ image: { url: 'https://example.test/result.png' } }),
});
assert.equal(jsonOutput.length, 1);
assert.equal(jsonOutput[0].path, 'https://example.test/result.png');

assert.equal(
  toolArtifactsFromPayload({
    output: 'The image is stored at C:\\workspace\\renders\\not-standalone.png for later use.',
  }).length,
  0,
  'Legacy text parsing must not scrape paths out of arbitrary prose',
);

const merged = mergeToolArtifacts(structured, [{
  ...structured[0],
  name: 'updated.png',
}]);
assert.equal(merged.length, 1);
assert.equal(merged[0].name, 'updated.png');

const apiSource = read('src', 'backend', 'api.ts');
const hookSource = read('src', 'hooks', 'useCardbushChat.ts');
const bubbleSource = read('src', 'features', 'chatMessages', 'MessageBubble.tsx');
const toolBlockSource = read('src', 'features', 'tools', 'ToolExecutionBlock.tsx');
const toolViewerSource = read('src', 'features', 'tools', 'ToolImageArtifactViewer.tsx');
const typesSource = read('src', 'types.ts');
const cssSource = read('src', 'styles', 'app.css');

assert.match(typesSource, /export interface ChatToolArtifact extends ChatAttachment/);
assert.match(typesSource, /artifacts\?: ChatToolArtifact\[\]/);
assert.equal(
  (apiSource.match(/toolArtifactsFromPayload\(/g) ?? []).length,
  2,
  'Live SSE and restored history must use the same artifact parser',
);
assert.match(hookSource, /mergeToolArtifacts\(current\.artifacts, incoming\.artifacts\)/);
assert.doesNotMatch(bubbleSource, /toolArtifactPaths/);
assert.match(toolBlockSource, /<ToolImageArtifactViewer/);
assert.match(toolViewerSource, /'查看图像'/);
assert.match(toolViewerSource, /readImageDataUrl\(pathValue\)/);
assert.match(cssSource, /\.message-image-preview img\s*\{[\s\S]*?object-fit:\s*contain/);
assert.match(cssSource, /\.image-preview-stage img\s*\{[\s\S]*?max-height:\s*calc\(100vh - 180px\)/);

console.log('tool media artifact contract tests passed');
