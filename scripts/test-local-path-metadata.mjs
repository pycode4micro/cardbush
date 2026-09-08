import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

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
  localFileReference,
  localFileReferenceFromHref,
  localFileReferenceHref,
  markdownLocalFileReference,
  remarkLocalFileReferences,
} = fileReferenceModule.exports;
const absoluteDocument = 'C:\\Users\\wfang\\Documents\\report.docx';
for (const destination of [
  'C:\\Users\\fixture\\拍摄脚本-3.mp4.md',
  'C:/Users/fixture/拍摄脚本-3.mp4.md',
  'C:%5CUsers%5Cfixture%5C%E6%8B%8D%E6%91%84%E8%84%9A%E6%9C%AC-3.mp4.md',
  'file:///C:/Users/fixture/%E6%8B%8D%E6%91%84%E8%84%9A%E6%9C%AC-3.mp4.md',
]) {
  const reference = markdownLocalFileReference(destination, 'D:\\fixture');
  assert.ok(reference, `Windows file destination must survive Markdown URL sanitization: ${destination}`);
  assert.equal(reference.path.replaceAll('\\', '/'), 'C:/Users/fixture/拍摄脚本-3.mp4.md');
  assert.equal(markdownLocalFileReference(localFileReferenceHref(reference.path)).path, reference.path);
}
for (const destination of ['', '#section', 'https://example.com/report.md', 'javascript:alert(1)', 'data:text/html,test', 'vbscript:evil', 'cardbush-local-file:relative.md']) {
  assert.equal(markdownLocalFileReference(destination, 'D:\\fixture'), null, `${destination} must not bypass standard URL sanitization`);
}
assert.equal(markdownLocalFileReference('report.md', 'D:\\fixture').path, 'D:\\fixture\\report.md');
const absoluteSkillDirectory =
  'C:\\Users\\wfang\\AppData\\Roaming\\cardbush\\skills\\transport-delivery';
assert.equal(localFileReference(absoluteDocument)?.path, absoluteDocument);
assert.equal(
  localFileReference(absoluteSkillDirectory)?.path,
  absoluteSkillDirectory,
  'Absolute directory paths must be valid local references even without an extension',
);
assert.equal(
  localFileReference(absoluteDocument, 'D:\\proj\\cardbush')?.path,
  absoluteDocument,
  'Absolute paths outside the workspace must not be rewritten to the workspace drive',
);
assert.equal(localFileReference('/work/reports/report.xlsx')?.path, '/work/reports/report.xlsx');
for (const route of ['/docs', '/mcp', '/uploads']) {
  assert.equal(
    localFileReference(route, 'D:\\proj\\cardbush'),
    null,
    `${route} must remain a web route in a Windows workspace`,
  );
}
assert.equal(
  localFileReference('/work/reports/report.xlsx', '/work/project')?.path,
  '/work/reports/report.xlsx',
  'POSIX paths must remain local references in a POSIX workspace',
);
assert.equal(
  localFileReference('src/App.tsx', 'D:\\proj\\cardbush')?.path,
  'D:\\proj\\cardbush\\src\\App.tsx',
  'Workspace-relative paths must resolve against the authoritative workspace root',
);
assert.equal(
  localFileReference('../outside/report.xlsx', 'D:\\proj\\cardbush'),
  null,
  'Relative paths must not escape the authoritative workspace root',
);
assert.equal(
  localFileReferenceFromHref(localFileReferenceHref('src/App.tsx')),
  '',
  'Internal file hrefs must not allow relative paths to bypass local-path validation',
);
const localPathTree = {
  type: 'root',
  children: [{
    type: 'paragraph',
    children: [{ type: 'text', value: `Open src/App.tsx and ${absoluteDocument}` }],
  }],
};
remarkLocalFileReferences({ workspaceRoot: 'D:\\proj\\cardbush' })(localPathTree);
const localPathLinks = localPathTree.children[0].children.filter((node) => node.type === 'link');
assert.equal(localPathLinks.length, 2);
assert.equal(localPathLinks[0].children[0].value, 'App.tsx');
assert.ok(localPathLinks[0].url.includes(encodeURIComponent('D:\\proj\\cardbush\\src\\App.tsx')));
assert.equal(localPathLinks[1].children[0].value, 'report.docx');

const linkedDirectoryTree = {
  type: 'root',
  children: [{
    type: 'paragraph',
    children: [{ type: 'text', value: `Skill 位于：${absoluteSkillDirectory}，可以打开查看。` }],
  }],
};
remarkLocalFileReferences({ workspaceRoot: 'D:\\proj\\cardbush' })(linkedDirectoryTree);
const directoryLink = linkedDirectoryTree.children[0].children.find((node) => node.type === 'link');
assert.equal(directoryLink.children[0].value, 'transport-delivery');
assert.ok(directoryLink.url.includes(encodeURIComponent(absoluteSkillDirectory)));

const nativeMarkdownTree = {
  type: 'root',
  children: [{
    type: 'paragraph',
    children: [
      { type: 'strong', children: [{ type: 'text', value: '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili' }] },
      { type: 'text', value: ' 已在浏览器新标签页中打开（' },
      { type: 'link', url: 'https://www.bilibili.com', children: [{ type: 'text', value: 'https://www.bilibili.com' }] },
      { type: 'text', value: '）。' },
    ],
  }],
};
const nativeMarkdownBefore = JSON.stringify(nativeMarkdownTree);
remarkLocalFileReferences({ workspaceRoot: 'D:\\proj\\cardbush' })(nativeMarkdownTree);
assert.equal(
  JSON.stringify(nativeMarkdownTree),
  nativeMarkdownBefore,
  'Native Markdown links and emphasis must remain untouched by local file enhancement.',
);

const bareWebUrlTree = {
  type: 'root',
  children: [{
    type: 'paragraph',
    children: [{ type: 'text', value: '打开（https://www.bilibili.com）。' }],
  }],
};
const bareWebUrlBefore = JSON.stringify(bareWebUrlTree);
remarkLocalFileReferences({ workspaceRoot: 'D:\\proj\\cardbush' })(bareWebUrlTree);
assert.equal(
  JSON.stringify(bareWebUrlTree),
  bareWebUrlBefore,
  'A web URL must never be interpreted as a Windows path beginning with s:/',
);

const dateTableCellTree = {
  type: 'root',
  children: [{
    type: 'tableCell',
    children: [{ type: 'text', value: '2026/9/29 18:30' }],
  }],
};
const dateTableCellBefore = JSON.stringify(dateTableCellTree);
remarkLocalFileReferences({ workspaceRoot: 'D:\\proj\\cardbush' })(dateTableCellTree);
assert.equal(
  JSON.stringify(dateTableCellTree),
  dateTableCellBefore,
  'Slash-formatted dates must not be promoted to local folder references',
);

const localReferenceLinkSource = fs.readFileSync(
  path.join(
    process.cwd(),
    'src',
    'features',
    'chatMessages',
    'LocalFileReferenceLink.tsx',
  ),
  'utf8',
);
assert.match(
  localReferenceLinkSource,
  /directoryLike[\s\S]*?cardbushDesktop\?\.openPath\?\.\(path\)/,
  'Directory references must open through the desktop shell instead of the file preview',
);
assert.match(localReferenceLinkSource, /inspectLocalReference/);
assert.match(localReferenceLinkSource, /applicationLike[\s\S]*?openPath\?\.\(path\)/);
assert.match(localReferenceLinkSource, /<FileTypeIcon path=\{path\} \/>/);
assert.match(localReferenceLinkSource, /if \(!inspectionComplete \|\| !metadata\)/);
assert.doesNotMatch(localReferenceLinkSource, /fallbackDirectoryLike/);

const fileTypeIconSource = fs.readFileSync(
  path.join(
    process.cwd(),
    'src',
    'features',
    'chatMessages',
    'FileTypeIcon.tsx',
  ),
  'utf8',
);
assert.match(fileTypeIconSource, /tsx.*jsx/);
assert.match(fileTypeIconSource, /typescript/);
assert.match(fileTypeIconSource, /javascript/);
assert.match(fileTypeIconSource, /function FileTypeIcon/);

const stylesSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'styles', 'app.css'),
  'utf8',
);
const localFileStyle = stylesSource.match(/\.local-file-reference\s*\{([^}]*)\}/)?.[1] ?? '';
assert.ok(!/border-bottom|text-decoration:\s*(?:underline|dotted|dashed)/.test(localFileStyle));
const inlineCodeStyle = stylesSource.match(
  /\.assistant-bubble :not\(pre\) > code,\s*\.user-bubble :not\(pre\) > code\s*\{([^}]*)\}/,
)?.[1] ?? '';
assert.match(inlineCodeStyle, /background:\s*transparent/);
assert.match(inlineCodeStyle, /padding:\s*0/);
assert.doesNotMatch(inlineCodeStyle, /color-mix/);

const electronMainSource = fs.readFileSync(
  path.join(process.cwd(), 'electron', 'main.ts'),
  'utf8',
);
assert.match(electronMainSource, /ipcMain\.handle\('files:inspect-local-reference'/);
assert.match(electronMainSource, /shell\.readShortcutLink\(normalizedPath\)/);
assert.match(electronMainSource, /getFileIcon\(normalizedPath/);
const fileContextMenuHandler = electronMainSource.match(
  /ipcMain\.handle\('shell:file-context-menu',[\s\S]*?\n\}\);/,
)?.[0] ?? '';
assert.match(fileContextMenuHandler, /const fileExists = fs\.existsSync\(normalizedPath\)/);
assert.match(fileContextMenuHandler, /文件不存在（无法打开）/);
assert.match(fileContextMenuHandler, /label: '复制路径'/);
assert.doesNotMatch(
  fileContextMenuHandler,
  /if \(!normalizedPath \|\| !fs\.existsSync\(normalizedPath\)\)/,
  'Missing files must still open a context menu so their path can be copied',
);

console.log('local path metadata tests passed');

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}
