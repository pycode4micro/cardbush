import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { registerSkillTools, ToolRegistry } from '../dist/index.js';

test('registers only the published Skill discovery tool', async () => {
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
    assert.equal(searchResult.matches[0].name, 'xlsx');
    assert.equal(searchResult.matches[0].mainResource, join(packageDir, 'SKILL.md'));

    assert.equal(registry.resolve('read_skill'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves active Skill roots for every search', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-dynamic-skills-'));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    await writeSkill(first, 'first-skill', 'First browser workflow');
    await writeSkill(second, 'second-skill', 'Second browser workflow');
    let activeRoots = [first];
    const registry = new ToolRegistry();
    registerSkillTools(registry, () => activeRoots);
    const search = registry.resolve('search_skills');

    const firstResult = await search.execute(context(
      search.decodeInput({ query: 'browser', limit: 5 }),
      'search_skills_first',
    ));
    assert.deepEqual(firstResult.matches.map((item) => item.name), ['first-skill']);

    activeRoots = [second];
    const secondResult = await search.execute(context(
      search.decodeInput({ query: 'browser', limit: 5 }),
      'search_skills_second',
    ));
    assert.deepEqual(secondResult.matches.map((item) => item.name), ['second-skill']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeSkill(root, name, description) {
  const packageDir = join(root, name);
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    `# ${name}`,
  ].join('\n'));
}

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
      dispatch_scope: 'runtime',
      mutating: false,
    },
    capabilityIds: [],
    recordWorkspaceChange() {},
  };
}
