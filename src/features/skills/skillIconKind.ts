import type { SkillSummary } from '../../types';

export type SkillIconKind =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
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
  'name' | 'description' | 'descriptionZh' | 'path'
>;

const skillIconRules: Array<{
  kind: SkillIconKind;
  pattern: RegExp;
}> = [
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

export function skillIconKind(skill: SkillIconSource): SkillIconKind {
  const searchable = [
    skill.name,
    skill.description,
    skill.descriptionZh ?? '',
    skill.path,
  ].join(' ');
  return skillIconRules.find((rule) => rule.pattern.test(searchable))?.kind ?? 'generic';
}
