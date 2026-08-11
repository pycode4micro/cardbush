import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const sourcePath = path.join(process.cwd(), 'src', 'backend', 'desktopAction.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const module = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module,
  exports: module.exports,
  Set,
});

const { desktopActionState, desktopActionToolPayload } = module.exports;

assert.equal(desktopActionState('queued'), 'using');
assert.equal(desktopActionState('running'), 'using');
assert.equal(desktopActionState('waiting_confirmation'), 'using');
assert.equal(desktopActionState('completed'), 'ok');
assert.equal(desktopActionState('failed'), 'fail');
assert.equal(desktopActionState('cancelled'), 'fail');

const running = plain(
  desktopActionToolPayload({
    id: 'action-1',
    name: 'desktop_install_app',
    status: 'waiting_confirmation',
    summary: 'Install requires confirmation',
    risk: 'high',
    verification: {},
  }),
);
assert.equal(running.state, 'using');
assert.equal(Object.hasOwn(running, 'success'), false);
assert.equal(running.metadata.desktop_action, true);
assert.equal(running.metadata.status, 'waiting_confirmation');
assert.equal(running.metadata.risk, 'high');

const completed = plain(
  desktopActionToolPayload({
    id: 'action-1',
    name: 'desktop_install_app',
    status: 'completed',
    summary: 'Installed',
    verification: { installed: true },
  }),
);
assert.equal(completed.state, 'ok');
assert.equal(completed.success, true);
assert.deepEqual(completed.metadata.verification, { installed: true });

console.log('desktop action contract tests passed');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
