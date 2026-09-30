import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
function load(file, dependencies = {}) {
  const module = { exports: {} };
  vm.runInNewContext(compile(readFileSync(file, 'utf8')), {
    module, exports: module.exports, URL, process, window: { cardbushDesktop: {} },
    require: name => dependencies[name] ?? require(name),
  }, { filename: file });
  return module.exports;
}
const paths = load('src/shared/localPaths.ts');
const protocol = load('electron/localFileProtocol.ts');
const { localResourcePath } = load('electron/localResourcePath.ts', { './localFileProtocol': protocol });
const references = [
  'cardbush-source:13-74679519b39c20e4', 'cardbush-memo:12', 'cardbush-reference://file/test',
  'cardbush-app:session/turn/tool', 'cardbush-source:invalid',
];
const invalid = [...references, ...['png', 'mp3', 'mp4', 'html', 'pdf'].map(ext => `unknown:resource.${ext}`),
  'relative/image.png', 'clip.mp4', 'C:voice.wav', '', 'file:///C:/bad%00.png', 'C:/bad\u0000.png'];
for (const target of invalid) {
  assert.equal(paths.resourceTargetKind(target), 'unsupported', target);
  assert.equal(paths.mediaResourceUrl(target), '', target);
  assert.equal(paths.fileUrl(target), '', target);
  for (const platform of ['win32', 'linux']) assert.throws(() => localResourcePath(target, platform), undefined, target);
}
for (const [target, platform, expected] of [
  ['C:/work/图片 #1 100%.png', 'win32', 'C:\\work\\图片 #1 100%.png'],
  ['C:\\work\\clip.mp4', 'win32', 'C:\\work\\clip.mp4'],
  ['\\\\server\\share\\voice.wav', 'win32', '\\\\server\\share\\voice.wav'],
  ['file://server/share/voice.wav', 'win32', '\\\\server\\share\\voice.wav'],
  ['file:///C:/work/%E5%9B%BE%E7%89%87%20%231.png', 'win32', 'C:\\work\\图片 #1.png'],
  ['/home/user/voice 1.wav', 'linux', '/home/user/voice 1.wav'],
  ['file:///home/user/clip.mp4', 'linux', '/home/user/clip.mp4'],
]) {
  assert.equal(paths.resourceTargetKind(target), 'local-file', target);
  const resourceUrl = paths.mediaResourceUrl(target);
  assert.equal(paths.mediaResourceUrl(resourceUrl), resourceUrl, 'transport URLs must not be encoded twice');
  assert.equal(localResourcePath(resourceUrl, platform), expected, target);
}
for (const target of ['https://example.org/clip.mp4?token=1', 'data:audio/wav;base64,AAAA', 'blob:https://example.org/id']) {
  assert.equal(paths.mediaResourceUrl(target), target);
  assert.equal(paths.fileUrl(target), '');
  assert.throws(() => localResourcePath(target, 'win32'));
}
const ssh = 'ssh://agent-123/home/user/%E5%BD%B1%E7%89%87.mp4';
assert.equal(paths.resourceTargetKind(ssh), 'ssh-file');
assert.equal(new URL(paths.fileUrl(ssh)).searchParams.get('path'), ssh);
assert.throws(() => localResourcePath(ssh, 'win32'));
for (const target of ['file:///C:/clip.mp4?x=1', 'file:///C:/clip.mp4#part', 'file:///C:relative.png',
  'cardbush-file://ssh-file/', 'cardbush-file://text-preview/', 'cardbush-file://office-source/', '/drive-relative.png']) {
  assert.throws(() => localResourcePath(target, 'win32'), undefined, target);
}

// Exercise the real IPC reader with filesystem spies: rejection must precede stat/readFile.
const source = ts.createSourceFile('main.ts', readFileSync('electron/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const reader = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readLocalImageDataUrl');
assert.ok(reader);
let io = 0;
const readImage = vm.runInNewContext(compile(reader.getText(source)) + '\nreadLocalImageDataUrl;', {
  localResourcePath, fs: { promises: { stat: async () => { io++; throw Error('Unexpected stat'); }, readFile: async () => { io++; } } },
});
for (const target of invalid) await assert.rejects(readImage(target));
assert.equal(io, 0, 'bad references must never reach the filesystem');
console.log('Resource targets passed: image/audio/video/document routing, reference rejection before filesystem I/O, native/file/UNC/SSH URLs.');
