import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';

// The registry/target modules must run without Electron, React or reading file contents.
const modules = new Map();
function load(file) {
  file = resolve(file);
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', 'window', code)(specifier => {
    assert.ok(specifier.startsWith('.'), `Unexpected runtime dependency: ${specifier}`);
    return load(resolve(dirname(file), specifier + '.ts'));
  }, module, module.exports, { cardbushDesktop: {} });
  return module.exports;
}
const { resolveFilePreview, createFilePreviewRegistry, filePreviewAdapters } = load('src/features/inspector/filePreviewRegistry.ts');
const { inspectorSource, inspectorMediaTarget, isMarkdownInspectorTarget } = load('src/features/inspector/inspectorTargets.ts');

test('only registered capabilities claim a local file; unknowns do not enter text or webview', () => {
  for (const name of ['archive.zip', 'project.psd', 'data.unknownfuture', 'noextension']) {
    assert.equal(resolveFilePreview(`C:/folder.txt/${name}`), null);
    for (const target of [`C:/${name}`, `file:///C:/${name}`, `cardbush-file:///C:/${name}`, `cardbush-file://text-preview/?path=${encodeURIComponent('C:/' + name)}`]) {
      assert.equal(inspectorSource(target), 'about:blank');
      assert.equal(inspectorMediaTarget(target), null);
      assert.equal(isMarkdownInspectorTarget(target), false);
    }
  }
  assert.equal(inspectorSource('https://example.com/avatar.blend'), 'https://example.com/avatar.blend', 'web URLs retain normal browser navigation');
});

test('existing format families and extensionless text names share the registry', () => {
  for (const [name, renderer] of [
    ['README', 'text'], ['Makefile', 'text'], ['.gitignore', 'text'], ['notes.MARKDOWN', 'markdown'],
    ['main.rs', 'text'], ['data.csv', 'text'], ['model.py', 'text'], ['photo.JPEG', 'image'],
    ['image.avif', 'image'], ['icon.svg', 'image'], ['movie.mov', 'video'], ['sound.flac', 'audio'],
    ['report.html', 'webview'], ['report.pdf', 'webview'], ['report.docx', 'webview'], ['report.pptx', 'webview'],
  ]) assert.equal(resolveFilePreview(`C:/${name}`)?.renderer, renderer, name);
  assert.equal(resolveFilePreview('C:/picture.png#notes.md')?.renderer, 'markdown');
  assert.equal(resolveFilePreview('C:/notes.md.unknown'), null);
  assert.equal(resolveFilePreview('C:/source.ts/asset.unknown'), null, 'directories do not match as extensions');
  assert.equal(inspectorSource('C:/sound #1.FLAC'), 'file:///C:/sound%20%231.FLAC');
  assert.equal(inspectorSource('\\\\server\\share\\sound.FLAC'), 'file://server/share/sound.FLAC');
  assert.equal(inspectorMediaTarget('cardbush-file://c/中文/image%20%231.png').path, 'C:\\中文\\image #1.png');
  const office = 'cardbush-file://office-preview/?path=C%3A%2Freport.xlsx&renderer=compat';
  assert.equal(inspectorSource(office), office, 'preserve Office renderer options for supported files');
  assert.equal(inspectorSource('C:/avatar.blend'), 'cardbush-file://model-preview/?path=C%3A%2Favatar.blend', 'Blender uses its isolated adapter, not the text decoder');
});

test('a new format reuses the registration interface, with explicit matching and conflict detection', () => {
  const custom = { id: 'future-format', extensions: ['.future'], fileNames: ['FutureDocument'], renderer: 'text', source: file => 'preview:' + file };
  const lookup = createFilePreviewRegistry([...filePreviewAdapters, custom]);
  assert.equal(lookup('C:/asset.FUTURE'), custom);
  assert.equal(lookup('C:/FutureDocument'), custom);
  assert.equal(lookup('C:/asset.future.backup'), null, 'no partial extension guesses');
  assert.equal(resolveFilePreview('C:/asset.future'), null, 'registries cannot mutate each other');
  assert.throws(() => createFilePreviewRegistry([...filePreviewAdapters, { ...custom, extensions: ['.TXT'] }]), /Duplicate file preview match/);
  assert.throws(() => createFilePreviewRegistry([...filePreviewAdapters, { ...custom, fileNames: ['readme'] }]), /Duplicate file preview match/);
  assert.throws(() => createFilePreviewRegistry([...filePreviewAdapters, { ...custom, id: 'text' }]), /Duplicate or empty file preview id/);
  assert.throws(() => createFilePreviewRegistry([{ ...custom, extensions: ['.*'] }]), /Invalid file preview extension/);
});
