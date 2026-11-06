import test from 'node:test';
import assert from 'node:assert/strict';
import { CHILD_AGENT_ASSIGNMENT_PREFIX, childAgentAssignmentText, readUserPrompt, promptModelContent, PREVIEW_SELECTION_INSTRUCTIONS, assistantProfileSchema } from '../dist/index.js';

test('assignment envelope preserves original text', () => {
  const prefix = CHILD_AGENT_ASSIGNMENT_PREFIX;
  const original = '中文任务；保留 English 和 {{value:name}}';
  assert.equal(childAgentAssignmentText(prefix + '\n\n' + original), original);
  assert.equal(childAgentAssignmentText(prefix + '只是普通引用'), undefined);
  assert.equal(childAgentAssignmentText('引用：' + prefix + '\n' + original), undefined);
});

test('selection envelope preserves model content and keeps authored text separate', () => {
  const instructions = PREVIEW_SELECTION_INSTRUCTIONS;
  const data = { requestId: '302236ec-7c0e-463e-8952-e6c8ebb700e0', file: 'C:/示例.pptx', locator: 'h1', text: '中文原文',
    selection: 'content', textScope: 'selected block', viewport: { width: 566, height: 633 } };
  const content = `修改选区\n\n${instructions}\n\n<preview-selection>\n${JSON.stringify(data)}\n</preview-selection>`;
  const parsed = readUserPrompt(content);
  assert.equal(parsed.text, '修改选区');
  assert.equal(parsed.context[0].requestId, data.requestId);
  assert.equal(promptModelContent(parsed), content);
  const quoted = `Earlier example:\n\n${PREVIEW_SELECTION_INSTRUCTIONS}\n\n<preview-selection>\n{}`;
  assert.equal(readUserPrompt(quoted + '\n\n' + content).text, quoted + '\n\n修改选区');
  const fenced = '```text\n' + content + '\n```';
  assert.equal(readUserPrompt(fenced).text, fenced);
  const invalid = content.replace('"content"', '"invalid"');
  assert.equal(readUserPrompt(invalid).text, invalid);
});

test('missing persona uses the runtime default, saved personas remain user data', () => {
  assert.equal(assistantProfileSchema.parse({}).persona, '');
  for (const persona of ['自定义中文角色', '  用中文答复 {{value:name}}  ', '']) {
    assert.equal(assistantProfileSchema.parse({ persona }).persona, persona);
  }
});
