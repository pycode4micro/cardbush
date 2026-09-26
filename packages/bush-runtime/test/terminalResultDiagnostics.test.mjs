import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, registerWorkspaceTools } from '../dist/index.js';

test('terminal receipts distinguish nonzero exit and diagnostics without rewriting native results', () => {
  const registry = new ToolRegistry(); registerWorkspaceTools(registry);
  for (const tool of ['terminal_exec', 'terminal_poll', 'terminal_write', 'terminal_stop']) {
    for (const [state, exitCode, stderr, expected] of [
      ['exited', 0, '', undefined],
      ['exited', 7, 'failure\r\n中文😀', /command failed/],
      ['exited', 0, 'warning: progress\r\n', /may include warnings or non-terminating errors/],
      ['running', null, 'progress', /diagnostic output/],
      ['failed', null, '', /command failed/],
    ]) {
      const result = { terminalSessionId: 'terminal-fixture', state, exitCode, stdout: 'saved\r\n', stderr };
      const original = structuredClone(result);
      const text = registry.renderModelResult(tool, result);
      const metadata = JSON.parse(text.split('\n\n')[0]);
      assert.equal(metadata.exitCode, exitCode); assert.equal(metadata.state, state);
      if (expected) assert.match(metadata.runtime_notice, expected);
      else assert.equal(metadata.runtime_notice, undefined);
      assert.ok(text.endsWith(`[stdout]\n${result.stdout}\n\n[stderr]\n${stderr}`));
      assert.deepEqual(result, original);
    }
  }
});
