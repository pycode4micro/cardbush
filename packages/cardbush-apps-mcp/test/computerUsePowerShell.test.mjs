import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runComputerUsePowerShell } from '../dist/plugins/computerUsePowerShell.js';
import { formatComputerUseError } from '../dist/plugins/computerUseErrors.js';

const windowsOnly = { skip: process.platform !== 'win32' };
const execute = (script, options = {}) => runComputerUsePowerShell(script, {
  cwd: process.cwd(), env: { ...process.env }, timeoutMs: 15000, ...options,
});

test('large native scripts execute intact over stdin, with Unicode, here-strings and environment data', windowsOnly, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'cardbush-powershell 中文 '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const literal = '中文😀\nquotes: \' " ` $env:DO_NOT_EXPAND $(throw "not code")';
  const script = `${'# native source padding\n'.repeat(6000)}
Add-Type -TypeDefinition @'
public static class CardBushTransportFixture {
  public static string Echo(string value) { return value; }
}
'@
$literal = @'
${literal}
'@
[PSCustomObject]@{
  text = [CardBushTransportFixture]::Echo($literal)
  environment = $env:CARDBUSH_TRANSPORT_TEST
  cwd = (Get-Location).Path
  commandLineLength = [Environment]::CommandLine.Length
} | ConvertTo-Json -Compress`;
  assert.ok(Buffer.from(script, 'utf16le').toString('base64').length > 32767);
  const result = JSON.parse(await execute(script, { cwd, env: { ...process.env, CARDBUSH_TRANSPORT_TEST: '值😀"$()' } }));
  assert.equal(result.text, literal);
  assert.equal(result.environment, '值😀"$()');
  assert.equal(result.cwd.toLowerCase(), cwd.toLowerCase());
  assert.ok(result.commandLineLength < 2000, 'script growth does not grow the process command line');
});

test('the complete production input script reaches target validation for every coordinate action', windowsOnly, async t => {
  const source = await readFile(new URL('../src/plugins/computerUseRuntime.ts', import.meta.url), 'utf8');
  const script = source.match(/const computerInputScript = String.raw`([\s\S]*?)`;/)?.[1];
  assert.ok(script);
  for (const action of ['click', 'type', 'key', 'scroll', 'drag', 'clipboard']) await t.test(action, async () => {
    // An impossible positive HWND fails GetWindowRect before any focus change,
    // pointer movement or keyboard event; the real C# and guards still execute.
    const payload = { action, hwnd: Number.MAX_SAFE_INTEGER, text: action === 'clipboard' ? '中'.repeat(8192) : 'do not send', key: 'Enter', x: 1, y: 1, delta: 1, to_x: 2, to_y: 2 };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
    if (action === 'clipboard') assert.ok(encoded.length > 32767);
    await assert.rejects(execute(script, { parameters: {
      CARDBUSH_INPUT_BASE64: encoded,
      CARDBUSH_YIELD_TO_USER: '0', CARDBUSH_RESTORE_POINTER: '1', CARDBUSH_EXPECTED_INPUT_TICK: '0',
    } }), error => {
      assert.notEqual(error.code, 'ENAMETOOLONG');
      assert.match(formatComputerUseError(error), /Target window hwnd=.*no longer available/);
      return true;
    });
  });
});

test('large request parameters stay literal script data rather than command-line or environment values', windowsOnly, async () => {
  const value = '中文😀\n\' " ` $env:DO_NOT_EXPAND $(throw "not code")'.repeat(2000);
  assert.ok(value.length > 32767);
  const result = JSON.parse(await execute(`[PSCustomObject]@{
    value=$script:CARDBUSH_LARGE_PAYLOAD
    inEnvironment=[Environment]::GetEnvironmentVariable('CARDBUSH_LARGE_PAYLOAD')
    commandLineLength=[Environment]::CommandLine.Length
  } | ConvertTo-Json -Compress`, { parameters: { CARDBUSH_LARGE_PAYLOAD: value } }));
  assert.equal(result.value, value);
  assert.equal(result.inEnvironment, null);
  assert.ok(result.commandLineLength < 2000);
});

test('script exceptions retain diagnostics and do not continue with later statements', windowsOnly, async () => {
  await assert.rejects(execute("throw '故障😀'\nWrite-Output 'must not run'"), error => {
    assert.match(formatComputerUseError(error), /故障😀/);
    assert.doesNotMatch(error.stdout, /must not run/);
    return true;
  });
});

test('script timeouts and cancellation still terminate the owned PowerShell process', windowsOnly, async () => {
  await assert.rejects(execute('Start-Sleep -Seconds 30', { timeoutMs: 500 }), error => error.killed === true);
  const controller = new AbortController();
  const pending = execute('Start-Sleep -Seconds 30', { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 500);
  try { await assert.rejects(pending, { name: 'AbortError' }); } finally { clearTimeout(timer); }
  // Cancellation during a large pipe write must not produce an unhandled EPIPE.
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(execute('# padding\n'.repeat(100000), { signal: stopped.signal }), { name: 'AbortError' });
});

test('spawn failures settle the pending script input instead of hanging', windowsOnly, async () => {
  await assert.rejects(execute('# padding\n'.repeat(100000), { cwd: join(tmpdir(), 'cardbush-missing-' + randomUUID()) }), { code: 'ENOENT' });
});
