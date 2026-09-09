import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    assert.equal('query' in searchResult, false);
    assert.equal(searchResult.matches[0].name, 'xlsx');
    assert.equal(searchResult.matches[0].mainResource, join(packageDir, 'SKILL.md'));

    const directRegistry = new ToolRegistry();
    registerSkillTools(directRegistry, [packageDir]);
    const directSearch = directRegistry.resolve('search_skills');
    const directResult = await directSearch.execute(context(searchInput, 'direct_skill_root'));
    assert.equal(directResult.matches[0].mainResource, join(packageDir, 'SKILL.md'), 'a declared individual Skill keeps its original resource directory');

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

test('discovers additions, edits and removals during a turn while preserving disabled skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-live-skill-'));
  try {
    const registry = new ToolRegistry();
    registerSkillTools(registry, [root]);
    const search = registry.resolve('search_skills');
    const ctx = { ...context({ query: 'browser', limit: 10 }, 'search'),
      turn: { request: { metadata: { disabledSkills: ['blocked'] } } } };
    assert.equal((await search.execute(ctx)).matches.length, 0);
    await writeSkill(root, 'added', 'browser workflow');
    await writeSkill(root, 'blocked', 'browser workflow');
    assert.deepEqual((await search.execute(ctx)).matches.map(item => item.name), ['added']);
    await writeSkill(root, 'added', 'spreadsheet workflow');
    assert.equal((await search.execute(ctx)).matches.length, 0);
    ctx.input.query = 'spreadsheet';
    assert.equal((await search.execute(ctx)).matches[0].name, 'added');
    ctx.turn.request.metadata.allowedSkills = [];
    assert.equal((await search.execute(ctx)).matches.length, 0, 'an explicit allowlist remains restrictive');
    delete ctx.turn.request.metadata.allowedSkills;
    await rm(join(root, 'added'), { recursive: true });
    assert.equal((await search.execute(ctx)).matches.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('finds bundled skills from natural Chinese requests and exact English names', async () => {
  const registry = new ToolRegistry();
  registerSkillTools(registry, [fileURLToPath(new URL('../../../assets/skills', import.meta.url))]);
  const search = registry.resolve('search_skills');
  for (const [query, expected] of [
    ['帮我分析视频中的动作', 'video-understanding'],
    ['制作演示文稿', 'pptx'],
    ['分析销售表格', 'xlsx'],
    ['修改应用主题', 'cardbush-style-management'],
    ['卸载插件', 'cardbush-plugin-management'],
    ['帮我把这个插件卸载掉', 'cardbush-plugin-management'],
    ['在CardBush添加MCP服务', 'cardbush-mcp-management'],
    ['cardbush-mcp-management', 'cardbush-mcp-management'],
    ['PPTX', 'pptx'],
    ['ｘｌｓｘ', 'xlsx'],
  ]) {
    const result = await search.execute(context({ query, limit: 8 }, 'search'));
    assert.equal(result.matches[0]?.name, expected, query);
  }
  for (const query of ['的', 'quasarxyz']) {
    assert.deepEqual((await search.execute(context({ query, limit: 8 }, 'search'))).matches, [], query);
  }
});

test('segments mixed Chinese and identifiers without changing root precedence or visibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-chinese-skills-'));
  try {
    const bundled = join(root, 'bundled');
    const personal = join(root, 'personal');
    await writeSkill(bundled, 'analysis', 'old workbook workflow', '分析表格');
    await writeSkill(personal, 'analysis', 'Inspect GLTF_2 assets', '检查模型材质');
    await writeSkill(personal, 'disabled', 'Inspect GLTF_2 assets', '检查模型材质');
    const registry = new ToolRegistry();
    registerSkillTools(registry, [bundled, personal]);
    const search = registry.resolve('search_skills');
    const ctx = { ...context({ query: '帮我检查GLTF_2模型材质', limit: 8 }, 'search'),
      turn: { request: { metadata: { disabledSkills: ['disabled'] } } } };
    const result = await search.execute(ctx);
    assert.deepEqual(result.matches.map(item => item.name), ['analysis']);
    assert.equal(result.matches[0].mainResource, join(personal, 'analysis', 'SKILL.md'));
    ctx.input.query = '材质';
    assert.equal((await search.execute(ctx)).matches[0]?.name, 'analysis');
    ctx.input.query = 'workbook';
    assert.deepEqual((await search.execute(ctx)).matches, []);
    ctx.input.query = '检查模型材质';
    ctx.turn.request.metadata.allowedSkills = [];
    assert.deepEqual((await search.execute(ctx)).matches, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function writeSkill(root, name, description, descriptionZh = '') {
  const packageDir = join(root, name);
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `description_zh: ${descriptionZh}`,
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
