import type { AppSection } from '../types';

export const sectionLabels: Record<AppSection, { zh: string; en: string }> = {
  chat: { zh: '对话', en: 'Chat' },
  os: { zh: 'OS', en: 'OS' },
  search: { zh: '搜索', en: 'Search' },
  skills: { zh: '技能', en: 'Skills' },
  tools: { zh: '工具', en: 'Tools' },
  subagents: { zh: '子 Agent', en: 'Subagents' },
  team: { zh: 'Team', en: 'Team' },
};
