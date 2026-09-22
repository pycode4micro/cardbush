import type { AppSection } from '../types';

export const sectionLabels: Record<AppSection, { zh: string; en: string }> = {
  agents: { zh: 'Agents', en: 'Agents' },
  chat: { zh: '对话', en: 'Chat' },
  plugins: { zh: '插件', en: 'Plugins' },
  automations: { zh: '定时与自动化', en: 'Automations' },
  skills: { zh: '技能', en: 'Skills' },
  subagents: { zh: '子 Agent', en: 'Subagents' },
  team: { zh: 'Team', en: 'Team' },
};
