import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePredicate, predicateEngine } from '../dist/eventPredicate.js';

const observation = { kind: 'tool_failed', nowMs: 123, toolName: 'read_file', status: 'failed' };

test('local predicates compile without running, evaluate only numeric decisions and start fresh each time', async () => {
  const engine = await predicateEngine();
  evaluatePredicate(engine, 'throw Error("not executed during registration")');
  assert.throws(() => evaluatePredicate(engine, 'return ('), /INVALID_CODE/);
  for (const expression of ['true', 'NaN', 'Promise.resolve(1)', '"1"', '2', 'undefined']) {
    assert.throws(() => evaluatePredicate(engine, 'return ' + expression, observation), /EXPECTED_ZERO_OR_ONE/);
  }
  const code = "if (globalThis.seen) return 0; globalThis.seen = true; return Number(observation.status === 'failed');";
  assert.equal(evaluatePredicate(engine, code, observation), true);
  assert.equal(evaluatePredicate(engine, code, observation), true);
  assert.equal(evaluatePredicate(engine, code, { ...observation, status: 'completed' }), false);
});

test('predicates cannot use host APIs or monopolize the scheduler', async () => {
  const engine = await predicateEngine();
  const code = 'return Number([typeof process, typeof require, typeof fetch, typeof WebSocket, typeof setTimeout].every(x => x === "undefined"));';
  assert.equal(evaluatePredicate(engine, code, observation), true);
  assert.throws(() => evaluatePredicate(engine, 'while (true) {}', observation), /EXECUTION_FAILED/);
  assert.equal(evaluatePredicate(engine, 'return 1', observation), true);
});
