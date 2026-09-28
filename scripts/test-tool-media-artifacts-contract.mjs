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
const legacy = toolArtifactsFromPayload({ result: {
  protocol: 'bush.artifact.v1', presentation: 'submitted',
  artifacts: [{ ...structured[0] }],
} });
assert.deepEqual(legacy, structured, 'historical presentation results render without their former tool implementation');
const wrapped = toolArtifactsFromPayload({ result: { mcp: { name: 'mcp__fixture__generate', server: 'fixture', tool: 'generate' }, result: {
  content: [{ type: 'resource_link', name: 'report.pdf', uri: 'https://example.test/report.pdf', mimeType: 'application/pdf' }],
  structuredContent: { artifacts: [{ type: 'image', path: 'C:/workspace/result.png' }] },
} } });
assert.deepEqual(Array.from(wrapped, artifact => artifact.type), ['image', 'document']);
assert.equal(wrapped[1].display, 'attachment');
const screenshot = toolArtifactsFromPayload({ result: { mcp: { name: 'mcp__chrome_devtools__take_screenshot' }, result: {
  content: [{ type: 'image', data: 'image-bytes', mimeType: 'image/png', annotations: { audience: ['assistant'] } }],
  structuredContent: { artifacts: [{ type: 'image', path: 'C:/workspace/capture.png', mimeType: 'image/png', display: 'inline' }] },
} } });
assert.equal(screenshot.length, 1, 'persisted screenshot is displayed once; model-only bytes are not a duplicate UI artifact');
assert.equal(screenshot[0].path, 'C:/workspace/capture.png');

const computerUseCapture = {
  content: [{ type: 'image', data: 'computer-use-pixels', mimeType: 'image/png' }],
  structuredContent: {
    output: { path: 'C:/workspace/capture.png' },
    image_delivery: { status: 'attached', count: 1 },
    paths: ['C:/workspace/capture.png'],
    artifacts: [{ artifact_id: 'capture', type: 'image', path: 'C:/workspace/capture.png',
      metadata: { model_input: false, source: 'cardbush_apps' } }],
  },
};
const computerUsePayload = result => ({ result: { mcp: { name: 'mcp__cardbush_apps__computer_use' }, result } });
const historicalCapture = toolArtifactsFromPayload(computerUsePayload(computerUseCapture));
assert.equal(historicalCapture.length, 1, 'pre-upgrade Computer Use observations display their saved image once');
assert.equal(historicalCapture[0].path, 'C:/workspace/capture.png');
const afterAction = structuredClone(computerUseCapture);
afterAction.structuredContent.output = { observation: afterAction.structuredContent.output };
assert.equal(toolArtifactsFromPayload(computerUsePayload(afterAction)).length, 1, 'post-action observations use the same history normalization');
const annotatedCapture = structuredClone(computerUseCapture);
annotatedCapture.content[0].annotations = { audience: ['assistant'] };
assert.equal(toolArtifactsFromPayload(computerUsePayload(annotatedCapture)).length, 1, 'new observations respect the MCP audience');
assert.equal(mergeToolArtifacts(historicalCapture, toolArtifactsFromPayload(computerUsePayload(annotatedCapture))).length, 1,
  'live and history projections merge into one saved preview');
const uncertainCapture = structuredClone(computerUseCapture);
uncertainCapture.structuredContent.image_delivery.status = 'unavailable';
assert.equal(toolArtifactsFromPayload(computerUsePayload(uncertainCapture)).length, 2, 'uncertain delivery cannot establish duplicate identity');
const differentPath = structuredClone(computerUseCapture);
differentPath.structuredContent.output.path = 'C:/workspace/other.png';
assert.equal(toolArtifactsFromPayload(computerUsePayload(differentPath)).length, 2, 'unmatched artifacts are not suppressed');
const extraImage = structuredClone(computerUseCapture);
extraImage.content.push({ type: 'image', data: 'different-pixels', mimeType: 'image/png' });
assert.equal(toolArtifactsFromPayload(computerUsePayload(extraImage)).length, 3, 'additional images remain visible');
assert.equal(toolArtifactsFromPayload({ result: { mcp: { name: 'mcp__other__tool' }, result: computerUseCapture } }).length, 2,
  'Computer Use history handling must not infer duplicate images for other tools');
const imageOnly = { content: [computerUseCapture.content[0]] };
assert.equal(toolArtifactsFromPayload(computerUsePayload(imageOnly)).length, 1, 'standalone MCP image remains visible');

const undeclared = toolArtifactsFromPayload({
  metadata: {
    result: {
      images: [{ image_path: 'D:\\tmp\\nested.webp' }],
    },
  },
  output: 'C:\\workspace\\renders\\legacy.jpg',
});
assert.deepEqual(
  Array.from(undeclared, (artifact) => artifact.path),
  [],
  'Artifact rendering must not search compatibility aliases or output prose',
);

const jsonOutput = toolArtifactsFromPayload({
  output: JSON.stringify({ image: { url: 'https://example.test/result.png' } }),
});
assert.equal(jsonOutput.length, 0);

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
const runtimeChatSource = read('src', 'backend', 'runtimeChat.ts');
const toolMergeSource = read('src/features/chatMessages/transcript/toolExecutionMerge.ts');
const bubbleSource = read('src', 'features', 'chatMessages', 'MessageBubble.tsx');
const toolBlockSource = read('src', 'features', 'tools', 'ToolExecutionBlock.tsx');
const toolViewerSource = read('src', 'features', 'tools', 'ToolImageArtifactViewer.tsx');
const typesSource = read('src', 'types.ts');
const cssSource = read('src', 'styles', 'app.css');

assert.match(typesSource, /export interface ChatToolArtifact extends ChatAttachment/);
assert.match(typesSource, /artifacts\?: ChatToolArtifact\[\]/);
assert.equal(
  (apiSource.match(/toolArtifactsFromPayload\(/g) ?? []).length,
  1,
  'History projection should read the same explicit native artifact channels',
);
assert.match(
  runtimeChatSource,
  /toolArtifactsFromPayload\(\{ result: record\.result \}\)/,
  'Live Runtime records should use the explicit native artifact adapter',
);
assert.doesNotMatch(apiSource, /restored HTTP history/i);
assert.match(toolMergeSource, /mergeToolArtifacts\(current\.artifacts, incoming\.artifacts\)/);
assert.doesNotMatch(bubbleSource, /toolArtifactPaths/);
assert.match(toolBlockSource, /<ToolImageArtifactViewer/);
assert.match(toolViewerSource, /'查看图像'/);
assert.match(toolViewerSource, /readImageDataUrl\(pathValue\)/);
assert.match(toolViewerSource, /<ImagePreviewDialog/);
assert.match(cssSource, /\.message-image-preview img\s*\{[\s\S]*?object-fit:\s*contain/);
assert.match(cssSource, /\.image-preview-canvas img\s*\{[\s\S]*?object-fit:\s*contain/);

console.log('tool media artifact contract tests passed');
