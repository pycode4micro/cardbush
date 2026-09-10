import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpDiscoveryResults } from '../dist/mcpToolDiscovery.js';

const payload = JSON.stringify({ protocol: 'bush.mcp_discovery.v1', sessionId: 's', matches: [{ name: 'mcp__docs__read', description: 'Read docs',
  inputSchema: { type: 'object' }, revision: 'v1' }] });
const locator = 'tool-result://s/t/search';
const history = () => [{ role: 'assistant', content: '', toolCalls: [{ id: 'search', name: 'mcp_search', argumentsText: '{}' }] },
  { role: 'tool', toolCallId: 'search', content: JSON.stringify({ archived: true, locator, originalChars: payload.length, preview: payload }) }];
const page = (id, offset, text) => [{ role: 'assistant', content: '', toolCalls: [{ id, name: 'read_archived_tool_result', argumentsText: JSON.stringify({ locator, offset }) }] },
  { role: 'tool', toolCallId: id, content: JSON.stringify({ locator, offset, next_offset: offset + text.length }) + '\n\n[text]\n' + text }];
const results = messages => [...mcpDiscoveryResults(messages, 's')];

test('exact overlapping and out-of-order archive pages load one schema only once', () => {
  const middle = Math.floor(payload.length / 2);
  const messages = [...history(), ...page('tail', middle, payload.slice(middle)), ...page('head', 0, payload.slice(0, middle + 5))];
  assert.equal(results(messages).length, 1);
  const first = results(messages)[0];
  messages.push(...page('repeat', 0, payload), ...page('tail-repeat', middle, payload.slice(middle)));
  assert.deepEqual(results(messages), [first]);
});

test('conflicting overlaps and repeated offsets never manufacture a complete archive', () => {
  const middle = Math.floor(payload.length / 2);
  for (const messages of [
    [...history(), ...page('head', 0, payload.slice(0, middle + 5)), ...page('conflict', middle, 'XXXXX' + payload.slice(middle + 5))],
    [...history(), ...page('head', 0, payload.slice(0, middle)), ...page('conflict', 0, payload.slice(0, middle).replace('bush', 'fake')), ...page('tail', middle, payload.slice(middle))],
  ]) assert.equal(results(messages).length, 0);
});

test('archive previews, missing pages, out-of-bounds and foreign session data do not load schemas', () => {
  const middle = Math.floor(payload.length / 2);
  for (const messages of [history(), [...history(), ...page('hole', 1, payload.slice(1))],
    [...history(), ...page('bad-offset', -1, payload)], [...history(), ...page('too-long', 0, payload + ' ')],
    [...history(), ...page('foreign', 0, payload.replace('"s"', '"x"'))],
    [...history(), ...page('head', 0, payload.slice(0, middle)), ...page('tail', middle + 1, payload.slice(middle + 1))],
  ]) assert.equal(results(messages).length, 0);
});
