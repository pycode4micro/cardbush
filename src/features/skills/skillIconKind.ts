import type { SkillSummary } from '../../types';

export type SkillIconKind =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'finance'
  | 'communication'
  | 'delivery'
  | 'image'
  | 'web'
  | 'computer'
  | 'security'
  | 'integration'
  | 'tooling'
  | 'design'
  | 'data'
  | 'research'
  | 'workflow'
  | 'code'
  | 'generic';

type SkillIconSource = Pick<
  SkillSummary,
  'name' | 'path'
>;

const exactSkillIconKinds: Readonly<Record<string, SkillIconKind>> = {
  docx: 'document',
  document: 'document',
  documents: 'document',
  xlsx: 'spreadsheet',
  spreadsheet: 'spreadsheet',
  spreadsheets: 'spreadsheet',
  pptx: 'presentation',
  presentation: 'presentation',
  presentations: 'presentation',
  pdf: 'pdf',
  'finance-analysis': 'finance',
  'financial-analysis': 'finance',
  'internal-comms': 'communication',
  'internal-communications': 'communication',
  'scheduled-delivery': 'delivery',
  'transport-delivery': 'delivery',
  'skill-manager': 'tooling',
  'skill-creator': 'tooling',
  'skill-installer': 'tooling',
  'plugin-creator': 'tooling',
  'cardbush-style-management': 'design',
};

const skillIconRules: Array<{
  kind: SkillIconKind;
  pattern: RegExp;
}> = [
  { kind: 'finance', pattern: /\b(?:finance|financial|valuation|portfolio|investments?)\b|财务|金融|估值|投资组合/i },
  { kind: 'communication', pattern: /\b(?:communications?|comms|announcements?|memos?)\b|沟通|公告|通报/i },
  { kind: 'delivery', pattern: /\b(?:delivery|deliver|transport|scheduled)\b|交付|投递|定时发送/i },
  { kind: 'presentation', pattern: /\b(?:pptx?|presentations?|slides?)\b|演示|幻灯片/i },
  { kind: 'spreadsheet', pattern: /\b(?:xlsx?|excel|spreadsheets?|sheets?|csv|tsv)\b|表格|工作簿/i },
  { kind: 'pdf', pattern: /\bpdfs?\b|便携式文档/i },
  { kind: 'document', pattern: /\b(?:docx?|documents?|word|rtf|odt)\b|文档|文字处理/i },
  { kind: 'image', pattern: /\b(?:imagegen|images?|photos?|visual|visualize|visualization|canvas)\b|图片|图像|视觉/i },
  { kind: 'web', pattern: /\b(?:browser|chrome|website|webview|sites?)\b|浏览器|网页|站点/i },
  { kind: 'computer', pattern: /\b(?:computer-use|desktop|windows|macos|linux)\b|电脑|桌面控制/i },
  { kind: 'security', pattern: /\b(?:security|audit|redline|permissions?)\b|安全|审计|权限/i },
  { kind: 'integration', pattern: /\b(?:plugins?|mcp|connectors?|integrations?)\b|插件|连接器|集成/i },
  { kind: 'tooling', pattern: /\b(?:skill-creator|skill-installer|installer|scaffold)\b|技能创建|技能安装|脚手架/i },
  { kind: 'design', pattern: /\b(?:figma|canva|templates?|design|theme)\b|设计|模板|主题/i },
  { kind: 'data', pattern: /\b(?:database|dataset|sql|airtable|analytics)\b|数据库|数据集|数据分析/i },
  { kind: 'research', pattern: /\b(?:research|scholar|docs|documentation|search)\b|研究|文献|知识库|搜索/i },
  { kind: 'workflow', pattern: /\b(?:workflow|agents?|subagents?|team|automation)\b|工作流|智能体|团队|自动化/i },
  { kind: 'code', pattern: /\b(?:code|coding|developer|programming|repository|github|git)\b|代码|编程|仓库/i },
];

function normalizedSkillIdentities(skill: SkillIconSource): string[] {
  const name = skill.name.trim().toLowerCase();
  const nameLeaf = name.split(':').at(-1) ?? name;
  const normalizedPath = skill.path.replace(/\\/g, '/').toLowerCase();
  const pathParts = normalizedPath.split('/').filter(Boolean);
  const skillFileIndex = pathParts.lastIndexOf('skill.md');
  const pathLeaf = skillFileIndex > 0 ? pathParts[skillFileIndex - 1] : '';
  return [...new Set([name, nameLeaf, pathLeaf, normalizedPath].filter(Boolean))];
}

export function skillIconKind(skill: SkillIconSource): SkillIconKind {
  const identities = normalizedSkillIdentities(skill);
  for (const identity of identities) {
    const exactKind = exactSkillIconKinds[identity];
    if (exactKind) return exactKind;
  }

  // Identity is the stable fact. Descriptions often contain exclusion phrases such as
  // "do not use for PDFs or presentations", so natural-language prose is never used as
  // icon metadata. Unknown identities deliberately stay generic until the skill supplies
  // a conventional logo asset or an explicit identity rule.
  const identityText = identities.join(' ');
  return skillIconRules.find((rule) => rule.pattern.test(identityText))?.kind ?? 'generic';
}
