import type { SubagentListItem } from '../types';

export type GameCodingRarity = 'N' | 'R' | 'SR' | 'SSR';
export type GameCodingElement =
  | 'logic'
  | 'patch'
  | 'debug'
  | 'test'
  | 'flow'
  | 'guard';

export type GameCodingStatLine = {
  focus: number;
  logic: number;
  tempo: number;
  guard: number;
};

export type GameCodingMode = 'idle_cards';

export type GameCodingCardProgress = {
  level: number;
  xp: number;
};

export type GameCodingLootRarity = 'common' | 'rare' | 'epic';

export type GameCodingInventoryItem = {
  id: string;
  nameZh: string;
  nameEn: string;
  rarity: GameCodingLootRarity;
  effectZh: string;
  effectEn: string;
  quantity: number;
};

export type GameCodingRunLog = {
  id: string;
  at: string;
  kind: 'reward' | 'stage' | 'train';
  textZh: string;
  textEn: string;
};

export type GameCodingIdleCardsState = {
  partyIds: string[];
  cards: Record<string, GameCodingCardProgress>;
  inventory: GameCodingInventoryItem[];
  log: GameCodingRunLog[];
  resources: {
    insight: number;
    cores: number;
  };
  run: {
    stage: number;
    progress: number;
    lastClaimAt: string;
  };
};

export type GameCodingCharacterPreset = {
  id: string;
  nameZh: string;
  nameEn: string;
  roleZh: string;
  roleEn: string;
  keywords: string[];
  hair: string;
  outfit: string;
  accent: string;
  bg: string;
  mark: string;
  hairStyle: 'short' | 'bob' | 'twin' | 'wave' | 'tail';
  rarity: GameCodingRarity;
  element: GameCodingElement;
  cardClassZh: string;
  cardClassEn: string;
  skillZh: string;
  skillEn: string;
  stats: GameCodingStatLine;
  power: number;
  image: string;
};

export type GameCodingMapPreset = {
  id: string;
  nameZh: string;
  nameEn: string;
  moodZh: string;
  moodEn: string;
  kind: 'city' | 'lab' | 'forest' | 'library' | 'harbor' | 'station' | 'shrine' | 'academy' | 'space' | 'cafe';
  primary: string;
  secondary: string;
  accent: string;
  chapterZh: string;
  chapterEn: string;
  difficulty: number;
  image: string;
};

export type GameCodingSettings = {
  mode: GameCodingMode;
  mapId: string;
  assignments: Record<string, string>;
  customMapPath: string;
  customCharacters: Record<string, string>;
  idleCards: GameCodingIdleCardsState;
};

const storageKey = 'cardbush.gamecoding.v1';

export const GAME_CODING_SETTINGS_EVENT = 'cardbush:gamecoding-settings';

export const gameCodingLootTemplates: Omit<GameCodingInventoryItem, 'quantity'>[] = [
  {
    id: 'trace-crystal',
    nameZh: '追踪晶片',
    nameEn: 'Trace Crystal',
    rarity: 'common',
    effectZh: '提升调试和日志任务收益',
    effectEn: 'Improves debug and logging rewards',
  },
  {
    id: 'patch-thread',
    nameZh: '补丁线轴',
    nameEn: 'Patch Thread',
    rarity: 'common',
    effectZh: '用于修复系角色训练',
    effectEn: 'Used for patch-role training',
  },
  {
    id: 'logic-sigil',
    nameZh: '逻辑纹章',
    nameEn: 'Logic Sigil',
    rarity: 'rare',
    effectZh: '强化搜索、规划和推理卡',
    effectEn: 'Boosts search, planning, and reasoning cards',
  },
  {
    id: 'runtime-core',
    nameZh: '运行核心',
    nameEn: 'Runtime Core',
    rarity: 'rare',
    effectZh: '为长任务提供额外推进力',
    effectEn: 'Adds momentum to long-running tasks',
  },
  {
    id: 'starlit-contract',
    nameZh: '星光契约',
    nameEn: 'Starlit Contract',
    rarity: 'epic',
    effectZh: '未来可解锁特殊 NPC 事件',
    effectEn: 'Can unlock special NPC events later',
  },
];

const characterSeeds = [
  ['logic-scout', '逻辑侦察员', 'Logic Scout', '搜索 / 侦查', 'Search / scout', ['search', 'scan', 'find', 'research', 'inspect'], '#2f2a3f', '#4f8cff', '#9ae6ff', '#13213a', '◇', 'short'],
  ['patch-knight', '补丁骑士', 'Patch Knight', '修复 / 守护', 'Fix / guard', ['fix', 'patch', 'repair', 'guard', 'safe'], '#473222', '#7c4dff', '#ffd36a', '#241936', '✦', 'tail'],
  ['debug-mage', '调试术士', 'Debug Mage', '调试 / 诊断', 'Debug / diagnose', ['debug', 'trace', 'diagnose', 'log', 'bug'], '#233644', '#00b894', '#8ef6c9', '#102a25', '✧', 'wave'],
  ['test-idol', '测试偶像', 'Test Idol', '测试 / 验证', 'Test / verify', ['test', 'qa', 'verify', 'pytest', 'check'], '#553044', '#ff6b9c', '#ffe1ec', '#321725', '✓', 'twin'],
  ['api-runner', '接口跑者', 'API Runner', '接口 / 集成', 'API / integration', ['api', 'http', 'request', 'endpoint', 'integration'], '#24364f', '#2dd4bf', '#e0fbff', '#10263a', '↗', 'short'],
  ['data-oracle', '数据预言家', 'Data Oracle', '数据 / 分析', 'Data / analysis', ['data', 'json', 'sql', 'analysis', 'metrics'], '#332844', '#a78bfa', '#f4eaff', '#211633', '◆', 'bob'],
  ['ui-artist', '界面画师', 'UI Artist', '界面 / 体验', 'UI / experience', ['ui', 'css', 'style', 'design', 'frontend'], '#5b392f', '#f59e0b', '#fff0c2', '#302016', '✿', 'wave'],
  ['doc-scribe', '文档书记', 'Doc Scribe', '文档 / 总结', 'Docs / summarize', ['doc', 'write', 'summary', 'readme', 'markdown'], '#2e3f34', '#84cc16', '#e7ffd0', '#17251a', '≡', 'tail'],
  ['build-smith', '构建铁匠', 'Build Smith', '构建 / 打包', 'Build / package', ['build', 'bundle', 'vite', 'electron', 'package'], '#4a3426', '#fb7185', '#ffe0d7', '#2f171a', '⚙', 'short'],
  ['git-ranger', '分支游侠', 'Git Ranger', 'Git / 版本', 'Git / versioning', ['git', 'branch', 'commit', 'diff', 'merge'], '#233a31', '#22c55e', '#d9ffe8', '#13271c', '⌁', 'bob'],
  ['security-warden', '安全守卫', 'Security Warden', '安全 / 权限', 'Security / policy', ['auth', 'token', 'security', 'permission', 'guard'], '#2d2f48', '#60a5fa', '#deecff', '#141827', '◈', 'tail'],
  ['terminal-operator', '终端机师', 'Terminal Operator', '终端 / 执行', 'Terminal / ops', ['terminal', 'shell', 'command', 'process', 'exec'], '#2c3340', '#94a3b8', '#f4f7fb', '#151a21', '▣', 'short'],
  ['model-tuner', '模型调音师', 'Model Tuner', '模型 / 推理', 'Model / reasoning', ['model', 'llm', 'reason', 'profile', 'prompt'], '#432d57', '#c084fc', '#ffe7ff', '#271531', '◎', 'wave'],
  ['cache-keeper', '缓存管理员', 'Cache Keeper', '缓存 / 状态', 'Cache / state', ['cache', 'state', 'storage', 'persist', 'memory'], '#273d3c', '#14b8a6', '#d5fff6', '#112826', '◌', 'bob'],
  ['browser-pilot', '浏览器领航员', 'Browser Pilot', '浏览器 / 观察', 'Browser / inspect', ['browser', 'page', 'dom', 'playwright', 'screenshot'], '#3f3448', '#38bdf8', '#e0f7ff', '#1c2530', '⌖', 'tail'],
  ['release-bard', '发布吟游者', 'Release Bard', '发布 / 说明', 'Release / notes', ['release', 'changelog', 'version', 'ship', 'note'], '#4d332f', '#f97316', '#ffe4d2', '#2c1814', '♪', 'wave'],
  ['refactor-ninja', '重构忍者', 'Refactor Ninja', '重构 / 清理', 'Refactor / cleanup', ['refactor', 'clean', 'rename', 'split', 'optimize'], '#23252f', '#64748b', '#f8fafc', '#12141b', '✕', 'short'],
  ['workflow-dancer', '流程舞者', 'Workflow Dancer', '流程 / 编排', 'Workflow / orchestration', ['workflow', 'plan', 'orchestrate', 'queue', 'parallel'], '#392742', '#ec4899', '#ffe4f5', '#25142b', '∞', 'twin'],
  ['infra-captain', '基础设施队长', 'Infra Captain', '服务 / 运行', 'Service / runtime', ['server', 'runtime', 'service', 'worker', 'agent'], '#26364b', '#0ea5e9', '#def5ff', '#121f31', '△', 'tail'],
  ['review-sentinel', '审查哨兵', 'Review Sentinel', '审查 / 风险', 'Review / risk', ['review', 'risk', 'lint', 'audit', 'quality'], '#3a2f2f', '#ef4444', '#ffe1df', '#271515', '!', 'bob'],
] satisfies Array<[
  string,
  string,
  string,
  string,
  string,
  string[],
  string,
  string,
  string,
  string,
  string,
  GameCodingCharacterPreset['hairStyle'],
]>;

const mapSeeds = [
  ['neon-rooftop', '霓虹屋顶', 'Neon Rooftop', '夜色城市 / 高速排障', 'Night city / fast debugging', 'city', '#172033', '#5b3f75', '#67e8f9'],
  ['subspace-lab', '亚空间实验室', 'Subspace Lab', '模型实验 / 工具编排', 'Model lab / tool orchestration', 'lab', '#15241f', '#256d6a', '#8ef6c9'],
  ['branch-forest', '分支森林', 'Branch Forest', '重构路线 / 多分支探索', 'Refactor routes / branch exploration', 'forest', '#142516', '#37693a', '#b7f58b'],
  ['archive-library', '星尘图书馆', 'Stardust Library', '文档整理 / 知识检索', 'Docs / knowledge retrieval', 'library', '#231b2f', '#5a426c', '#f7d58a'],
  ['harbor-terminal', '港口终端', 'Harbor Terminal', '接口联调 / 数据流转', 'API integration / data flow', 'harbor', '#132a3a', '#2b6f8e', '#9ae6ff'],
  ['railway-cache', '缓存月台', 'Cache Platform', '缓存检查 / 队列等待', 'Cache checks / queue waiting', 'station', '#242730', '#5c6470', '#fbbf24'],
  ['moon-shrine', '月见神社', 'Moon Shrine', '安全策略 / 准入判断', 'Security policy / admission', 'shrine', '#2c1f27', '#6b2d4c', '#f9a8d4'],
  ['academy-yard', '学院庭院', 'Academy Yard', '测试训练 / 角色分工', 'Testing drills / role split', 'academy', '#1d2c42', '#3f6ea5', '#fde68a'],
  ['orbit-dock', '轨道船坞', 'Orbit Dock', '构建发布 / 大任务推进', 'Build and release / large tasks', 'space', '#101827', '#4338ca', '#a5b4fc'],
  ['rain-cafe', '雨夜咖啡馆', 'Rain Cafe', '轻量协作 / 总结复盘', 'Light collaboration / recap', 'cafe', '#2e241f', '#72513d', '#fcd9a6'],
] satisfies Array<[
  string,
  string,
  string,
  string,
  string,
  GameCodingMapPreset['kind'],
  string,
  string,
  string,
]>;

const characterAssetById: Record<string, string> = {
  'logic-scout': new URL('../assets/gamecoding/characters/logic-scout.webp', import.meta.url).href,
  'patch-knight': new URL('../assets/gamecoding/characters/patch-knight.webp', import.meta.url).href,
  'debug-mage': new URL('../assets/gamecoding/characters/debug-mage.webp', import.meta.url).href,
  'test-idol': new URL('../assets/gamecoding/characters/test-idol.webp', import.meta.url).href,
  'api-runner': new URL('../assets/gamecoding/characters/api-runner.webp', import.meta.url).href,
  'data-oracle': new URL('../assets/gamecoding/characters/data-oracle.webp', import.meta.url).href,
  'ui-artist': new URL('../assets/gamecoding/characters/ui-artist.webp', import.meta.url).href,
  'doc-scribe': new URL('../assets/gamecoding/characters/doc-scribe.webp', import.meta.url).href,
  'build-smith': new URL('../assets/gamecoding/characters/build-smith.webp', import.meta.url).href,
  'git-ranger': new URL('../assets/gamecoding/characters/git-ranger.webp', import.meta.url).href,
  'security-warden': new URL('../assets/gamecoding/characters/security-warden.webp', import.meta.url).href,
  'terminal-operator': new URL('../assets/gamecoding/characters/terminal-operator.webp', import.meta.url).href,
  'model-tuner': new URL('../assets/gamecoding/characters/model-tuner.webp', import.meta.url).href,
  'cache-keeper': new URL('../assets/gamecoding/characters/cache-keeper.webp', import.meta.url).href,
  'browser-pilot': new URL('../assets/gamecoding/characters/browser-pilot.webp', import.meta.url).href,
  'release-bard': new URL('../assets/gamecoding/characters/release-bard.webp', import.meta.url).href,
  'refactor-ninja': new URL('../assets/gamecoding/characters/refactor-ninja.webp', import.meta.url).href,
  'workflow-dancer': new URL('../assets/gamecoding/characters/workflow-dancer.webp', import.meta.url).href,
  'infra-captain': new URL('../assets/gamecoding/characters/infra-captain.webp', import.meta.url).href,
  'review-sentinel': new URL('../assets/gamecoding/characters/review-sentinel.webp', import.meta.url).href,
};

const mapAssetById: Record<string, string> = {
  'neon-rooftop': new URL('../assets/gamecoding/maps/neon-rooftop.png', import.meta.url).href,
  'subspace-lab': new URL('../assets/gamecoding/maps/subspace-lab.png', import.meta.url).href,
  'branch-forest': new URL('../assets/gamecoding/maps/branch-forest.png', import.meta.url).href,
  'archive-library': new URL('../assets/gamecoding/maps/archive-library.png', import.meta.url).href,
  'harbor-terminal': new URL('../assets/gamecoding/maps/harbor-terminal.png', import.meta.url).href,
  'railway-cache': new URL('../assets/gamecoding/maps/railway-cache.png', import.meta.url).href,
  'moon-shrine': new URL('../assets/gamecoding/maps/moon-shrine.png', import.meta.url).href,
  'academy-yard': new URL('../assets/gamecoding/maps/academy-yard.png', import.meta.url).href,
  'orbit-dock': new URL('../assets/gamecoding/maps/orbit-dock.png', import.meta.url).href,
  'rain-cafe': new URL('../assets/gamecoding/maps/rain-cafe.png', import.meta.url).href,
};

export const animeCharacterPresets: GameCodingCharacterPreset[] = characterSeeds.map(
  ([id, nameZh, nameEn, roleZh, roleEn, keywords, hair, outfit, accent, bg, mark, hairStyle], index) => {
    const cardMeta = characterCardMeta(id, keywords, index);
    return {
      id,
      nameZh,
      nameEn,
      roleZh,
      roleEn,
      keywords,
      hair,
      outfit,
      accent,
      bg,
      mark,
      hairStyle,
      ...cardMeta,
      image: characterAssetById[id] ?? svgDataUri(characterSvg({ id, hair, outfit, accent, bg, hairStyle, index, rarity: cardMeta.rarity })),
    };
  },
);

export const animeMapPresets: GameCodingMapPreset[] = mapSeeds.map(
  ([id, nameZh, nameEn, moodZh, moodEn, kind, primary, secondary, accent], index) => ({
    id,
    nameZh,
    nameEn,
    moodZh,
    moodEn,
    kind,
    primary,
    secondary,
    accent,
    chapterZh: `第 ${index + 1} 章`,
    chapterEn: `Chapter ${index + 1}`,
    difficulty: 18 + index * 7,
    image: mapAssetById[id] ?? svgDataUri(mapSvg({ id, kind, primary, secondary, accent, index })),
  }),
);

export function readGameCodingSettings(): GameCodingSettings {
  if (typeof window === 'undefined') {
    return defaultGameCodingSettings();
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return defaultGameCodingSettings();
    }
    const parsed = JSON.parse(raw) as Partial<GameCodingSettings>;
    return normalizeGameCodingSettings(parsed);
  } catch {
    return defaultGameCodingSettings();
  }
}

export function saveGameCodingSettings(settings: GameCodingSettings) {
  const normalized = normalizeGameCodingSettings(settings);
  window.localStorage.setItem(storageKey, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(GAME_CODING_SETTINGS_EVENT, { detail: normalized }));
  return normalized;
}

export function gameCodingMapImage(
  settings: GameCodingSettings,
  agents: Array<Pick<SubagentListItem, 'name' | 'displayName' | 'description' | 'tags' | 'source'>> = [],
) {
  return settings.customMapPath
    ? gameCodingLocalImageUrl(settings.customMapPath)
    : mapPresetForSettings(settings, agents).image;
}

export function mapPresetForSettings(
  settings: GameCodingSettings,
  agents: Array<Pick<SubagentListItem, 'name' | 'displayName' | 'description' | 'tags' | 'source'>> = [],
) {
  if (settings.mapId !== 'auto') {
    return animeMapPresets.find((item) => item.id === settings.mapId) ?? animeMapPresets[0];
  }
  return mapPresetForAgents(agents);
}

export function characterPresetForAgent(
  agent: Pick<SubagentListItem, 'id' | 'name' | 'displayName' | 'description' | 'tags' | 'source'>,
  index: number,
  settings: GameCodingSettings,
) {
  const assigned = settings.assignments[agent.id] ?? settings.assignments[agent.name];
  if (assigned) {
    const preset = animeCharacterPresets.find((item) => item.id === assigned);
    if (preset) {
      return preset;
    }
  }
  const haystack = `${agent.name} ${agent.displayName} ${agent.description} ${agent.tags.join(' ')} ${agent.source}`.toLowerCase();
  const scored = animeCharacterPresets
    .map((preset) => ({
      preset,
      score: preset.keywords.reduce(
        (total, keyword) => total + (haystack.includes(keyword) ? 1 : 0),
        0,
      ),
    }))
    .sort((left, right) => right.score - left.score);
  if (scored[0]?.score > 0) {
    return scored[0].preset;
  }
  return animeCharacterPresets[Math.abs(hashText(agent.id || agent.name || String(index))) % animeCharacterPresets.length];
}

export function gameCodingCharacterImageForAgent(
  agent: Pick<SubagentListItem, 'id' | 'name' | 'displayName' | 'description' | 'tags' | 'source'>,
  index: number,
  settings: GameCodingSettings,
) {
  const customPath = settings.customCharacters[agent.id] ?? settings.customCharacters[agent.name] ?? '';
  if (customPath) {
    return gameCodingLocalImageUrl(customPath);
  }
  return characterPresetForAgent(agent, index, settings).image;
}

export function gameCodingAgentKey(agent: Pick<SubagentListItem, 'id' | 'name'>) {
  return agent.id || agent.name;
}

export function gameCodingCardProgressForAgent(
  settings: GameCodingSettings,
  agent: Pick<SubagentListItem, 'id' | 'name'>,
) {
  return normalizeCardProgress(settings.idleCards.cards[gameCodingAgentKey(agent)]);
}

export function gameCodingNextXp(level: number) {
  return 80 + Math.max(1, level) * 34;
}

export function gameCodingDisplayName(
  preset: Pick<GameCodingCharacterPreset | GameCodingMapPreset, 'nameZh' | 'nameEn'>,
  language: 'zh' | 'en',
) {
  return language === 'zh' ? preset.nameZh : preset.nameEn;
}

export function gameCodingRoleText(
  preset: Pick<GameCodingCharacterPreset, 'roleZh' | 'roleEn'>,
  language: 'zh' | 'en',
) {
  return language === 'zh' ? preset.roleZh : preset.roleEn;
}

export function gameCodingMoodText(
  preset: Pick<GameCodingMapPreset, 'moodZh' | 'moodEn'>,
  language: 'zh' | 'en',
) {
  return language === 'zh' ? preset.moodZh : preset.moodEn;
}

function normalizeGameCodingSettings(value: Partial<GameCodingSettings>): GameCodingSettings {
  const mapId = value.mapId === 'auto' || animeMapPresets.some((item) => item.id === value.mapId)
    ? String(value.mapId)
    : 'auto';
  const assignments: Record<string, string> = {};
  const rawAssignments =
    value.assignments && typeof value.assignments === 'object'
      ? value.assignments
      : {};
  for (const [agentId, presetId] of Object.entries(rawAssignments)) {
    if (
      typeof agentId === 'string' &&
      typeof presetId === 'string' &&
      animeCharacterPresets.some((item) => item.id === presetId)
    ) {
      assignments[agentId] = presetId;
    }
  }
  const customCharacters: Record<string, string> = {};
  const rawCustomCharacters =
    value.customCharacters && typeof value.customCharacters === 'object'
      ? value.customCharacters
      : {};
  for (const [agentId, imagePath] of Object.entries(rawCustomCharacters)) {
    if (typeof agentId === 'string' && typeof imagePath === 'string' && imagePath.trim()) {
      customCharacters[agentId] = imagePath.trim();
    }
  }
  const idleCards = normalizeIdleCardsState(value.idleCards);
  return {
    mode: 'idle_cards',
    mapId,
    assignments,
    customMapPath: typeof value.customMapPath === 'string' ? value.customMapPath.trim() : '',
    customCharacters,
    idleCards,
  };
}

function defaultGameCodingSettings(): GameCodingSettings {
  return {
    mode: 'idle_cards',
    mapId: 'auto',
    assignments: {},
    customMapPath: '',
    customCharacters: {},
    idleCards: defaultIdleCardsState(),
  };
}

function normalizeIdleCardsState(value: unknown): GameCodingIdleCardsState {
  const record = value != null && typeof value === 'object'
    ? (value as Partial<GameCodingIdleCardsState>)
    : {};
  const partyIds = Array.isArray(record.partyIds)
    ? Array.from(new Set(record.partyIds.map((item) => String(item ?? '').trim()).filter(Boolean))).slice(0, 5)
    : [];
  const cards: Record<string, GameCodingCardProgress> = {};
  const rawCards = record.cards && typeof record.cards === 'object'
    ? record.cards
    : {};
  for (const [id, progress] of Object.entries(rawCards)) {
    if (typeof id === 'string' && id.trim()) {
      cards[id] = normalizeCardProgress(progress);
    }
  }
  const resourcesRecord: Record<string, unknown> = record.resources && typeof record.resources === 'object'
    ? (record.resources as Record<string, unknown>)
    : {};
  const runRecord: Record<string, unknown> = record.run && typeof record.run === 'object'
    ? (record.run as Record<string, unknown>)
    : {};
  return {
    partyIds,
    cards,
    inventory: normalizeInventory(record.inventory),
    log: normalizeRunLog(record.log),
    resources: {
      insight: finiteNonNegativeNumber(resourcesRecord.insight),
      cores: finiteNonNegativeNumber(resourcesRecord.cores),
    },
    run: {
      stage: Math.max(1, Math.floor(finiteNonNegativeNumber(runRecord.stage) || 1)),
      progress: Math.max(0, Math.min(100, finiteNonNegativeNumber(runRecord.progress))),
      lastClaimAt: typeof runRecord.lastClaimAt === 'string' && runRecord.lastClaimAt
        ? runRecord.lastClaimAt
        : new Date().toISOString(),
    },
  };
}

function defaultIdleCardsState(): GameCodingIdleCardsState {
  return {
    partyIds: [],
    cards: {},
    inventory: [],
    log: [],
    resources: {
      insight: 0,
      cores: 0,
    },
    run: {
      stage: 1,
      progress: 0,
      lastClaimAt: new Date().toISOString(),
    },
  };
}

function normalizeInventory(value: unknown): GameCodingInventoryItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const templatesById = new Map(gameCodingLootTemplates.map((item) => [item.id, item]));
  const merged = new Map<string, GameCodingInventoryItem>();
  for (const item of value) {
    if (item == null || typeof item !== 'object') {
      continue;
    }
    const record = item as Partial<GameCodingInventoryItem>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const template = templatesById.get(id);
    if (!template) {
      continue;
    }
    const previous = merged.get(id);
    const quantity = Math.max(1, Math.floor(finiteNonNegativeNumber(record.quantity) || 1));
    merged.set(id, {
      ...template,
      quantity: (previous?.quantity ?? 0) + quantity,
    });
  }
  return Array.from(merged.values()).slice(0, 24);
}

function normalizeRunLog(value: unknown): GameCodingRunLog[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (item == null || typeof item !== 'object') {
        return null;
      }
      const record = item as Partial<GameCodingRunLog>;
      const id = typeof record.id === 'string' && record.id.trim()
        ? record.id.trim()
        : `log-${Date.now()}`;
      const kind = record.kind === 'stage' || record.kind === 'train' ? record.kind : 'reward';
      const at = typeof record.at === 'string' && record.at ? record.at : new Date().toISOString();
      const textZh = typeof record.textZh === 'string' ? record.textZh.trim() : '';
      const textEn = typeof record.textEn === 'string' ? record.textEn.trim() : '';
      if (!textZh && !textEn) {
        return null;
      }
      return {
        id,
        at,
        kind,
        textZh: textZh || textEn,
        textEn: textEn || textZh,
      };
    })
    .filter((item): item is GameCodingRunLog => item != null)
    .slice(0, 24);
}

function normalizeCardProgress(value: unknown): GameCodingCardProgress {
  const record = value != null && typeof value === 'object'
    ? (value as Partial<GameCodingCardProgress>)
    : {};
  return {
    level: Math.max(1, Math.min(99, Math.floor(finiteNonNegativeNumber(record.level) || 1))),
    xp: Math.max(0, Math.floor(finiteNonNegativeNumber(record.xp))),
  };
}

function finiteNonNegativeNumber(value: unknown) {
  const numberValue = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0;
}

function gameCodingLocalImageUrl(value: string) {
  const trimmed = value.trim();
  if (/^(data:|https?:|cardbush-file:|file:)/i.test(trimmed)) {
    return trimmed;
  }
  const normalized = trimmed.replaceAll('\\', '/');
  const backgroundName = cachedBackgroundFileName(normalized);
  if (backgroundName && typeof window !== 'undefined' && window.cardbushDesktop) {
    return `cardbush-file://backgrounds/${encodeURIComponent(backgroundName)}`;
  }
  const encodedPath = normalized
    .replace(/^\/+/, '')
    .split('/')
    .map((segment, index) =>
      index === 0 && /^[a-z]:$/i.test(segment)
        ? segment
        : encodeURIComponent(segment),
    )
    .join('/');
  const scheme = typeof window !== 'undefined' && window.cardbushDesktop ? 'cardbush-file' : 'file';
  return `${scheme}:///${encodedPath}`;
}

function cachedBackgroundFileName(value: string) {
  if (!/\/backgrounds\//i.test(value)) {
    return '';
  }
  const fileName = value.split('/').filter(Boolean).pop() ?? '';
  return /\.(png|jpe?g|webp|gif|bmp|ico)$/i.test(fileName) ? fileName : '';
}

function mapPresetForAgents(
  agents: Array<Pick<SubagentListItem, 'name' | 'displayName' | 'description' | 'tags' | 'source'>>,
) {
  const haystack = agents
    .map((agent) => `${agent.name} ${agent.displayName} ${agent.description} ${agent.tags.join(' ')} ${agent.source}`)
    .join(' ')
    .toLowerCase();
  const scores = [
    ['subspace-lab', ['model', 'llm', 'reason', 'profile', 'tool', 'agent']],
    ['branch-forest', ['git', 'branch', 'refactor', 'cleanup', 'merge']],
    ['archive-library', ['doc', 'readme', 'markdown', 'summary', 'knowledge']],
    ['harbor-terminal', ['api', 'http', 'endpoint', 'integration', 'request']],
    ['railway-cache', ['cache', 'queue', 'state', 'storage', 'persist']],
    ['moon-shrine', ['auth', 'token', 'security', 'permission', 'policy']],
    ['academy-yard', ['test', 'qa', 'verify', 'pytest', 'check']],
    ['orbit-dock', ['build', 'release', 'electron', 'bundle', 'ship']],
    ['neon-rooftop', ['browser', 'page', 'ui', 'css', 'frontend', 'search']],
    ['rain-cafe', ['note', 'chat', 'recap', 'write']],
  ].map(([id, keywords]) => ({
    id,
    score: (keywords as string[]).reduce(
      (total, keyword) => total + (haystack.includes(keyword) ? 1 : 0),
      0,
    ),
  }));
  const best = scores.sort((left, right) => right.score - left.score)[0];
  if (!best || best.score <= 0) {
    return animeMapPresets.find((item) => item.id === 'rain-cafe') ?? animeMapPresets[0];
  }
  return animeMapPresets.find((item) => item.id === best?.id) ?? animeMapPresets[0];
}

function hashText(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

function characterCardMeta(id: string, keywords: string[], index: number) {
  const rarityCycle: GameCodingRarity[] = [
    'SR',
    'R',
    'SR',
    'SSR',
    'R',
    'SR',
    'R',
    'R',
    'SR',
    'R',
    'SSR',
    'N',
    'SR',
    'R',
    'SR',
    'R',
    'SSR',
    'SR',
    'R',
    'SR',
  ];
  const keywordText = `${id} ${keywords.join(' ')}`;
  const element: GameCodingElement =
    /test|qa|verify|review|audit|risk/.test(keywordText)
      ? 'test'
      : /fix|patch|refactor|clean|build|release/.test(keywordText)
        ? 'patch'
        : /debug|trace|log|terminal|shell/.test(keywordText)
          ? 'debug'
          : /auth|security|permission|guard|cache|state/.test(keywordText)
            ? 'guard'
            : /workflow|plan|queue|parallel|model|llm/.test(keywordText)
              ? 'flow'
              : 'logic';
  const classNames: Record<GameCodingElement, [string, string, string, string]> = {
    logic: ['星图斥候', 'Star Scout', '检索星轨', 'Trace Signal'],
    patch: ['补丁骑士', 'Patch Knight', '修复连击', 'Patch Chain'],
    debug: ['断点术士', 'Debug Mage', '断点占卜', 'Breakpoint Read'],
    test: ['验收偶像', 'Test Idol', '全量验演', 'Full Trial'],
    flow: ['流程舞者', 'Flow Dancer', '并行编舞', 'Parallel Choreo'],
    guard: ['准入守卫', 'Gate Warden', '护盾审计', 'Shield Audit'],
  };
  const rarity = rarityCycle[index % rarityCycle.length];
  const rarityBonus = { N: 0, R: 5, SR: 11, SSR: 18 }[rarity];
  const base = 48 + ((Math.abs(hashText(id)) + index * 13) % 26);
  const stats = {
    focus: clampStat(base + rarityBonus + (element === 'flow' ? 9 : 0)),
    logic: clampStat(base + rarityBonus + (element === 'logic' ? 10 : 0)),
    tempo: clampStat(base + rarityBonus + (element === 'debug' || element === 'patch' ? 8 : 0)),
    guard: clampStat(base + rarityBonus + (element === 'guard' || element === 'test' ? 8 : 0)),
  };
  return {
    rarity,
    element,
    cardClassZh: classNames[element][0],
    cardClassEn: classNames[element][1],
    skillZh: classNames[element][2],
    skillEn: classNames[element][3],
    stats,
    power: Math.round((stats.focus + stats.logic + stats.tempo + stats.guard) / 4) + rarityBonus,
  };
}

function clampStat(value: number) {
  return Math.max(18, Math.min(99, value));
}

function svgDataUri(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function characterSvg({
  id,
  hair,
  outfit,
  accent,
  bg,
  hairStyle,
  index,
  rarity,
}: {
  id: string;
  hair: string;
  outfit: string;
  accent: string;
  bg: string;
  hairStyle: GameCodingCharacterPreset['hairStyle'];
  index: number;
  rarity: GameCodingRarity;
}) {
  const hairPath = {
    short: 'M73 164c9-61 54-94 113-83 46 9 74 42 75 94-29-28-67-39-115-35-34 3-58 12-73 24Z',
    bob: 'M72 170c6-66 50-100 114-91 61 8 94 57 79 127-24-24-48-34-83-34-44 0-76 14-110-2Z',
    twin: 'M76 166c10-61 53-93 108-85 51 7 83 39 88 90-26-18-55-28-91-28-42 0-75 11-105 23Zm-16 45c-42 7-63 34-61 70 39-4 68-23 81-59Zm218 0c42 7 63 34 61 70-39-4-68-23-81-59Z',
    wave: 'M69 173c11-70 53-105 119-96 72 9 110 66 99 142-34-46-61-29-94-49-37-22-72 19-124 3Z',
    tail: 'M74 166c9-67 55-98 119-84 56 12 89 55 80 118-33-31-68-41-116-35-28 4-55 6-83 1Zm191 42c43 8 69 34 66 76-42-6-68-32-76-69Z',
  }[hairStyle];
  const skin = index % 3 === 0 ? '#ffd9bd' : index % 3 === 1 ? '#f3c7aa' : '#ffe2c9';
  const eye = index % 2 === 0 ? '#1d3557' : '#3b2f54';
  const gemCount = { N: 1, R: 2, SR: 3, SSR: 4 }[rarity];
  const gems = Array.from({ length: gemCount }, (_, item) => {
    const x = 224 + item * 16;
    const y = 48;
    return `<path d="M${x} ${y - 8}l8 8-8 8-8-8Z" fill="${accent}" opacity="${0.62 + item * 0.08}"/>`;
  }).join('');
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 440" role="img">
  <defs>
    <linearGradient id="${id}-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bg}"/>
      <stop offset=".58" stop-color="${outfit}"/>
      <stop offset="1" stop-color="#101116"/>
    </linearGradient>
    <linearGradient id="${id}-rim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity=".48"/>
      <stop offset=".44" stop-color="#fff" stop-opacity=".08"/>
      <stop offset="1" stop-color="${accent}" stop-opacity=".24"/>
    </linearGradient>
    <linearGradient id="${id}-shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".38"/>
      <stop offset=".48" stop-color="#fff" stop-opacity=".04"/>
      <stop offset="1" stop-color="#000" stop-opacity=".26"/>
    </linearGradient>
  </defs>
  <rect width="320" height="440" rx="36" fill="url(#${id}-bg)"/>
  <path d="M34 78h252M34 346h252M70 42v354M250 42v354" stroke="#fff" stroke-opacity=".08" stroke-width="2"/>
  <path d="M58 360l102-58 104 58-104 58Z" fill="#05070b" opacity=".36"/>
  <path d="M73 344l87-50 88 50-88 50Z" fill="${accent}" opacity=".2"/>
  <ellipse cx="160" cy="200" rx="112" ry="122" fill="${accent}" opacity=".13"/>
  <path d="M73 371c12-74 60-113 130-105 55 6 91 45 105 105Z" fill="#080b10" opacity=".34"/>
  <path d="M84 369c12-76 59-114 126-105 52 7 86 46 99 105Z" fill="${outfit}"/>
  <path d="M115 301c29 23 61 33 94 30 27-2 51-12 72-30 12 19 21 42 27 68H84c7-30 17-53 31-68Z" fill="#fff" opacity=".09"/>
  <path d="M111 360h98l24-84c-24-12-51-18-80-14-23 4-43 13-61 27Z" fill="#0d1117" opacity=".18"/>
  <rect x="136" y="246" width="49" height="54" rx="22" fill="${skin}"/>
  <ellipse cx="160" cy="186" rx="76" ry="82" fill="${skin}"/>
  <path d="${hairPath}" fill="${hair}"/>
  <path d="M95 170c41-24 96-29 160 8" stroke="url(#${id}-rim)" stroke-width="9" stroke-linecap="round"/>
  <path d="M93 211c-18-19-20-40-7-55 6 23 13 42 24 57Z" fill="${hair}" opacity=".72"/>
  <path d="M228 213c19-20 21-42 7-58-7 25-14 43-25 59Z" fill="${hair}" opacity=".72"/>
  <ellipse cx="129" cy="197" rx="10" ry="14" fill="${eye}"/>
  <ellipse cx="191" cy="197" rx="10" ry="14" fill="${eye}"/>
  <circle cx="133" cy="192" r="4" fill="#fff"/>
  <circle cx="195" cy="192" r="4" fill="#fff"/>
  <path d="M143 235c13 11 34 11 47 0" fill="none" stroke="#8b3f4d" stroke-width="5" stroke-linecap="round"/>
  <circle cx="106" cy="219" r="12" fill="#ff9fb4" opacity=".34"/>
  <circle cx="214" cy="219" r="12" fill="#ff9fb4" opacity=".34"/>
  <path d="M93 303c-28 22-43 47-45 76 31-10 54-30 70-60Z" fill="${outfit}" opacity=".88"/>
  <path d="M238 303c30 22 47 48 49 77-34-9-58-30-76-60Z" fill="${outfit}" opacity=".88"/>
  <circle cx="245" cy="93" r="28" fill="#080b10" opacity=".3"/>
  <path d="M245 72l14 21-14 21-14-21Z" fill="${accent}" opacity=".86"/>
  <path d="M245 82l7 11-7 11-7-11Z" fill="#fff" opacity=".44"/>
  ${gems}
  <path d="M28 34h264v372H28Z" fill="none" stroke="#fff" stroke-opacity=".13" stroke-width="2"/>
  <rect width="320" height="440" rx="36" fill="url(#${id}-shine)"/>
</svg>`;
}

function mapSvg({
  id,
  kind,
  primary,
  secondary,
  accent,
  index,
}: {
  id: string;
  kind: GameCodingMapPreset['kind'];
  primary: string;
  secondary: string;
  accent: string;
  index: number;
}) {
  const scene = mapScene(kind, primary, secondary, accent, index);
  const board = isometricBoard(kind, primary, secondary, accent, index);
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" role="img">
  <defs>
    <linearGradient id="${id}-sky" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${primary}"/>
      <stop offset=".62" stop-color="${secondary}"/>
      <stop offset="1" stop-color="#0b0f14"/>
    </linearGradient>
    <linearGradient id="${id}-mist" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/>
      <stop offset=".62" stop-color="#fff" stop-opacity=".04"/>
      <stop offset="1" stop-color="#000" stop-opacity=".42"/>
    </linearGradient>
  </defs>
  <rect width="960" height="540" fill="url(#${id}-sky)"/>
  <circle cx="${160 + index * 53 % 620}" cy="${82 + index * 17 % 80}" r="92" fill="${accent}" opacity=".16"/>
  <path d="M0 365C160 290 270 392 420 318c140-68 265-90 540 2v220H0Z" fill="#0d1218" opacity=".3"/>
  <g opacity=".45">${scene}</g>
  ${board}
  <path d="M0 86h960M0 210h960M0 334h960M120 0v540M360 0v540M600 0v540M840 0v540" stroke="#fff" stroke-opacity=".055"/>
  <rect width="960" height="540" fill="url(#${id}-mist)"/>
</svg>`;
}

function isometricBoard(
  kind: GameCodingMapPreset['kind'],
  primary: string,
  secondary: string,
  accent: string,
  index: number,
) {
  const tile = (cx: number, cy: number, w: number, h: number, top: string, side = '#0b1015') => `
    <path d="M${cx} ${cy - h / 2}l${w / 2} ${h / 2}-${w / 2} ${h / 2}-${w / 2}-${h / 2}Z" fill="${top}"/>
    <path d="M${cx - w / 2} ${cy}l${w / 2} ${h / 2}v42l-${w / 2}-${h / 2}Z" fill="${side}" opacity=".62"/>
    <path d="M${cx + w / 2} ${cy}l-${w / 2} ${h / 2}v42l${w / 2}-${h / 2}Z" fill="#05070b" opacity=".45"/>`;
  const node = (cx: number, cy: number, scale: number, color: string) => `
    <g transform="translate(${cx} ${cy}) scale(${scale})">
      <path d="M0-34l58 34-58 34-58-34Z" fill="${color}" opacity=".88"/>
      <path d="M-58 0L0 34v24l-58-34Z" fill="#05070b" opacity=".34"/>
      <path d="M58 0L0 34v24l58-34Z" fill="#000" opacity=".2"/>
      <circle cx="0" cy="-3" r="15" fill="#fff" opacity=".2"/>
    </g>`;
  const building = {
    city: `
      <path d="M560 218l58 34v96l-58 34-58-34v-96Z" fill="${secondary}" opacity=".9"/>
      <path d="M560 174l58 34-58 34-58-34Z" fill="${accent}" opacity=".62"/>
      <path d="M502 208l58 34v140l-58-34Z" fill="#05070b" opacity=".28"/>
      <path d="M618 208l-58 34v140l58-34Z" fill="#fff" opacity=".08"/>`,
    lab: `
      <ellipse cx="560" cy="254" rx="92" ry="46" fill="${accent}" opacity=".25"/>
      <path d="M504 212h112l34 62-90 54-90-54Z" fill="${secondary}" opacity=".82"/>
      <path d="M530 194h62l22 36-53 31-53-31Z" fill="#f6ffff" opacity=".16"/>`,
    forest: `
      <path d="M522 266l38-96 38 96Z" fill="${secondary}" opacity=".95"/>
      <path d="M610 295l30-78 30 78Z" fill="${accent}" opacity=".62"/>
      <path d="M452 297l30-80 30 80Z" fill="${primary}" opacity=".82"/>`,
    library: `
      <path d="M480 228l90-52 90 52-90 52Z" fill="${accent}" opacity=".28"/>
      <path d="M500 210h140v92H500Z" fill="${secondary}" opacity=".72"/>
      <path d="M524 228h26v54h-26Zm43 0h26v54h-26Zm43 0h26v54h-26Z" fill="#080b10" opacity=".48"/>`,
    harbor: `
      <path d="M470 287c96-34 156-34 238 0v58H470Z" fill="${accent}" opacity=".26"/>
      <path d="M510 248h142l64 45H470Z" fill="#0b1015" opacity=".68"/>
      <path d="M557 207h58l22 41h-102Z" fill="${secondary}" opacity=".74"/>`,
    station: `
      <path d="M476 250h210l52 52H424Z" fill="#0b1015" opacity=".74"/>
      <path d="M505 218h152v58H505Z" fill="${secondary}" opacity=".72"/>
      <path d="M432 342h310" stroke="${accent}" stroke-width="12" stroke-opacity=".34"/>`,
    shrine: `
      <path d="M476 235h232" stroke="${accent}" stroke-width="18" stroke-linecap="round" opacity=".78"/>
      <path d="M514 246v100M670 246v100" stroke="#101116" stroke-width="22"/>
      <path d="M520 294h146l38 54H482Z" fill="${secondary}" opacity=".62"/>`,
    academy: `
      <path d="M474 210h210v118H474Z" fill="#0e1420" opacity=".72"/>
      <path d="M474 240h210M538 210v118M620 210v118" stroke="${accent}" stroke-opacity=".38" stroke-width="5"/>
      <path d="M548 210l31-46 31 46Z" fill="${accent}" opacity=".36"/>`,
    space: `
      <ellipse cx="590" cy="274" rx="128" ry="54" fill="#050912" opacity=".62"/>
      <path d="M475 274c50-52 184-52 234 0" stroke="${accent}" stroke-width="9" stroke-opacity=".46" fill="none"/>
      <path d="M544 222h90l44 52-89 52-89-52Z" fill="${secondary}" opacity=".68"/>`,
    cafe: `
      <path d="M470 232h210v110H470Z" fill="#15100d" opacity=".72"/>
      <path d="M496 206h160l44 42H452Z" fill="${secondary}" opacity=".72"/>
      <circle cx="648" cy="188" r="48" fill="${accent}" opacity=".2"/>`,
  }[kind];
  return `
    <g filter="none">
      <ellipse cx="494" cy="404" rx="330" ry="86" fill="#020305" opacity=".32"/>
      ${tile(480, 316, 560, 238, primary, secondary)}
      <path d="M248 316l232 132 232-132" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="2"/>
      <path d="M322 334c84 34 183 34 286 0" fill="none" stroke="${accent}" stroke-opacity=".35" stroke-width="10" stroke-linecap="round"/>
      ${node(332, 328, 0.62, accent)}
      ${node(430, 286, 0.72, secondary)}
      ${node(662, 332, 0.62, accent)}
      ${building}
      <path d="M214 390l266 153 266-153" fill="none" stroke="#000" stroke-opacity=".18" stroke-width="20"/>
    </g>`;
}

function mapScene(
  kind: GameCodingMapPreset['kind'],
  primary: string,
  secondary: string,
  accent: string,
  index: number,
) {
  const lampX = 110 + (index * 71) % 720;
  if (kind === 'city') {
    return `
      <g opacity=".94">
        ${Array.from({ length: 10 }, (_, item) => {
          const x = item * 100 - 24;
          const h = 160 + ((item * 53 + index * 17) % 170);
          return `<rect x="${x}" y="${350 - h}" width="78" height="${h}" rx="8" fill="#111722" opacity=".82"/><path d="M${x + 16} ${210 - h / 5}h46M${x + 16} ${250 - h / 6}h46M${x + 16} ${290 - h / 7}h46" stroke="${accent}" stroke-opacity=".3" stroke-width="5"/>`;
        }).join('')}
        <path d="M0 430h960" stroke="${accent}" stroke-opacity=".45" stroke-width="4"/>
      </g>`;
  }
  if (kind === 'lab') {
    return `
      <g fill="none" stroke="${accent}" stroke-width="4" opacity=".55">
        <path d="M170 150h620v250H170Z"/>
        <path d="M250 150v250M710 150v250M170 250h620"/>
        <circle cx="480" cy="272" r="70"/>
        <path d="M480 202v140M410 272h140"/>
      </g>
      <rect x="210" y="360" width="540" height="58" rx="20" fill="#08100f" opacity=".42"/>`;
  }
  if (kind === 'forest') {
    return Array.from({ length: 18 }, (_, item) => {
      const x = item * 58 + ((index * 23) % 32);
      const y = 250 + ((item * 17) % 70);
      return `<path d="M${x} ${y}l38-96 38 96Z" fill="${item % 2 ? secondary : primary}" opacity=".72"/><rect x="${x + 31}" y="${y - 10}" width="14" height="80" fill="#23170f" opacity=".7"/>`;
    }).join('');
  }
  if (kind === 'library') {
    return `
      <g opacity=".82">
        ${Array.from({ length: 8 }, (_, item) => `<rect x="${80 + item * 104}" y="150" width="68" height="230" rx="6" fill="${item % 2 ? primary : secondary}"/><path d="M${98 + item * 104} 180v160" stroke="${accent}" stroke-opacity=".35" stroke-width="6"/>`).join('')}
        <path d="M80 385h820" stroke="${accent}" stroke-width="8" stroke-opacity=".45"/>
      </g>`;
  }
  if (kind === 'harbor') {
    return `
      <path d="M0 360c170-38 270 30 440 0s300-60 520 0v180H0Z" fill="${accent}" opacity=".25"/>
      <path d="M140 340h680M180 300h140l70 40H130Z" fill="#0b1014" opacity=".64"/>
      <path d="M600 292h130l66 48H548Z" fill="#0b1014" opacity=".56"/>
      <path d="M${lampX} 118v210M${lampX - 80} 190h160" stroke="${accent}" stroke-width="6" stroke-opacity=".42"/>`;
  }
  if (kind === 'station') {
    return `
      <path d="M70 320h820" stroke="${accent}" stroke-width="8" stroke-opacity=".38"/>
      <path d="M110 220h740v112H110Z" fill="#111720" opacity=".7"/>
      <path d="M180 220v112M330 220v112M480 220v112M630 220v112M780 220v112" stroke="#fff" stroke-opacity=".12" stroke-width="5"/>
      <path d="M0 440h960M90 390l-48 150M870 390l48 150" stroke="#0b0f14" stroke-width="12" opacity=".65"/>`;
  }
  if (kind === 'shrine') {
    return `
      <path d="M190 190h580" stroke="${accent}" stroke-width="16" stroke-linecap="round"/>
      <path d="M260 200v190M700 200v190" stroke="#171015" stroke-width="24"/>
      <path d="M330 260h300l54 80H276Z" fill="#171015" opacity=".8"/>
      <path d="M120 430c190-90 530-90 720 0" stroke="${accent}" stroke-width="5" stroke-opacity=".38" fill="none"/>`;
  }
  if (kind === 'academy') {
    return `
      <rect x="210" y="150" width="540" height="240" rx="18" fill="#0f1722" opacity=".68"/>
      <path d="M210 190h540M300 150v240M660 150v240" stroke="${accent}" stroke-width="5" stroke-opacity=".38"/>
      <path d="M420 150l60-70 60 70Z" fill="${accent}" opacity=".28"/>
      <path d="M0 430h960" stroke="#0b0f14" stroke-width="28" opacity=".45"/>`;
  }
  if (kind === 'space') {
    return `
      ${Array.from({ length: 38 }, (_, item) => `<circle cx="${(item * 83 + index * 47) % 960}" cy="${(item * 37 + index * 19) % 300}" r="${1 + item % 3}" fill="#fff" opacity="${0.25 + (item % 4) * 0.12}"/>`).join('')}
      <ellipse cx="482" cy="310" rx="270" ry="74" fill="#0c111a" opacity=".58"/>
      <path d="M244 310c88-62 375-62 476 0" stroke="${accent}" stroke-width="8" stroke-opacity=".42" fill="none"/>
      <rect x="388" y="238" width="190" height="92" rx="34" fill="${secondary}" opacity=".55"/>`;
  }
  return `
    <rect x="160" y="190" width="640" height="190" rx="30" fill="#16120f" opacity=".66"/>
    <path d="M180 250h600M220 190v190M740 190v190" stroke="${accent}" stroke-width="5" stroke-opacity=".32"/>
    <circle cx="720" cy="150" r="68" fill="${accent}" opacity=".18"/>
    <path d="M90 420h780" stroke="#0b0f14" stroke-width="20" opacity=".55"/>`;
}
