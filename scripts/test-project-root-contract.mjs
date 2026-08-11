import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const sourcePath = path.join(process.cwd(), 'electron', 'projectRoots.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const module = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module,
  exports: module.exports,
  require(specifier) {
    if (specifier === 'node:fs') return fs;
    if (specifier === 'node:path') return path;
    throw new Error(`Unexpected module: ${specifier}`);
  },
  Set,
  String,
});

const { inspectProjectRoots } = module.exports;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-project-roots-'));

try {
  const projectDirectory = path.join(temporaryRoot, 'Project');
  const ordinaryFile = path.join(temporaryRoot, 'file.txt');
  const missingDirectory = path.join(temporaryRoot, 'missing');
  fs.mkdirSync(projectDirectory);
  fs.writeFileSync(ordinaryFile, 'not a project directory');

  const statuses = inspectProjectRoots([
    projectDirectory,
    projectDirectory.toUpperCase(),
    ordinaryFile,
    missingDirectory,
    ' ',
  ]);

  assert.equal(statuses.length, 3);
  assert.equal(statuses[0].rootPath, projectDirectory);
  assert.equal(statuses[0].exists, true);
  assert.equal(statuses[1].rootPath, ordinaryFile);
  assert.equal(statuses[1].exists, false);
  assert.equal(statuses[2].rootPath, missingDirectory);
  assert.equal(statuses[2].exists, false);
  assert.equal(statuses[0].resolvedPath, path.resolve(projectDirectory));
} finally {
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
}

console.log('project root contract tests passed');
