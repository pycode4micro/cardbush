import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { registerSkillTools, ToolRegistry } from '../dist/index.js';

test('searches Skill cards generically and reads only package-contained resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-skills-'));
  try {
    const packageDir = join(root, 'sheets');
    await mkdir(join(packageDir, 'references'), { recursive: true });
    await writeFile(join(packageDir, 'SKILL.md'), [
      '---',
      'name: xlsx',
      'description: "Create and edit spreadsheet workbooks"',
      'description_zh: "创建和编辑电子表格"',
      '---',
      '# Spreadsheet',
      'Read references/style.md when formatting.',
    ].join('\n'));
    await writeFile(join(packageDir, 'references', 'style.md'), '# Style');

    const registry = new ToolRegistry();
    registerSkillTools(registry, [root]);
    const search = registry.resolve('search_skills');
    const searchInput = search.decodeInput({ query: 'spreadsheet', limit: 5 });
    const searchResult = await search.execute(context(searchInput, 'search_skills'));
    assert.equal(searchResult.success, true);
    assert.equal(searchResult.output.matches[0].name, 'xlsx');

    const read = registry.resolve('read_skill');
    const readInput = read.decodeInput({ name: 'xlsx', resource: 'references/style.md' });
    const readResult = await read.execute(context(readInput, 'read_skill'));
    assert.equal(readResult.output.content, '# Style');

    assert.throws(
      () => read.decodeInput({ name: 'xlsx', resource: join(root, 'outside') }),
      /relative/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function context(input, name) {
  return {
    requestId: 'request_skill',
    sessionId: 'session_skill',
    turnId: 'turn_skill',
    toolCall: {
      protocol: 'bush.tool_call.v1',
      id: `call_${name}`,
      name,
      argumentsText: '{}',
    },
    input,
    actionManifest: {
      protocol: 'bush.tool.action_manifest.v1',
      manifest_id: `manifest_${name}`,
      effect_kind: 'observation',
      operation: `skills.${name}`,
      risk: 'low',
      owner: 'runtime',
      dispatch_phase: 'execution',
      dispatch_scope: 'runtime',
      dispatch_side_effect: 'none',
      dispatch_mutating: false,
      dispatch_source: 'test',
      stage_modes: ['read'],
      output_kinds: ['skill_instruction'],
      handoff_exports: [],
      evidence_hints: [],
    },
    capabilityIds: [],
  };
}
