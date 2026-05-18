import type {
  AutomationTask,
  ChatMessage,
  ConversationSummary,
  ProjectItem,
  SkillSummary,
} from '../types';

export const projects: ProjectItem[] = [
  {
    id: 'cardbush',
    title: 'cardbush',
    rootPath: 'C:/Users/wfang/Desktop/cardbush',
    pinned: true,
    branch: 'main',
    changedCount: 18,
  },
  {
    id: 'bush-server',
    title: 'BushServer',
    rootPath: 'C:/Users/wfang/Desktop/bush-server',
    branch: 'develop',
    changedCount: 2,
  },
];

export const conversations: ConversationSummary[] = [
  {
    id: 'conv-electron',
    title: 'Electron 迁移计划',
    preview: '先做 Flutter 设计清单，然后按清单复刻桌面体验。',
    updatedAt: '2026-05-18T10:30:00.000Z',
    projectDir: 'C:/Users/wfang/Desktop/cardbush',
  },
  {
    id: 'conv-scroll',
    title: 'Windows 滚动体验',
    preview: '实测迟滞感明显，迁出 Flutter 桌面。',
    updatedAt: '2026-05-18T09:50:00.000Z',
    projectDir: 'C:/Users/wfang/Desktop/cardbush',
  },
  {
    id: 'conv-i18n',
    title: '应用语言切换',
    preview: '后端提示词固定英文，语言只控制应用 UI。',
    updatedAt: '2026-05-17T22:40:00.000Z',
  },
];

export const messages: ChatMessage[] = [
  {
    id: 'u1',
    role: 'user',
    content:
      '转 Electron 吧，把 cardbush 的 Flutter 设计先做一个全面的清单，然后跟着清单对照进行一致，样式保持一致，只是更换架构实现而已。',
  },
  {
    id: 'a1',
    role: 'assistant',
    content:
      '收到。我会把迁移拆成两层：先建立 Flutter 设计清单，再按清单实现 Electron 版本，避免样式漂移。\n\n```ts\nconst migrationGoal = \"same product, smoother desktop shell\";\n```\n\n第一版会先覆盖窗口框架、侧栏、聊天主界面、composer 和设置入口。',
  },
  {
    id: 'u2',
    role: 'user',
    content: '重点是滚动和整体桌面手感，UI 不要重新设计。',
  },
  {
    id: 'a2',
    role: 'assistant',
    content:
      'Electron 版会默认使用 Chromium 原生滚动，并把聊天列表放到虚拟列表里。视觉 token 会直接按 Flutter 现有的 parchment / bright / dark 三套主题复刻。',
  },
];

export const skills: SkillSummary[] = [
  {
    name: 'browser',
    description: 'Inspect and verify local UI targets.',
    descriptionZh: '检查和验证本地 UI 页面。',
    path: '.codex/plugins/browser',
  },
  {
    name: 'github',
    description: 'Work with issues, pull requests, and CI.',
    descriptionZh: '处理 GitHub issue、PR 和 CI。',
    path: '.codex/plugins/github',
  },
  {
    name: 'documents',
    description: 'Create and edit document artifacts.',
    descriptionZh: '创建和编辑文档产物。',
    path: '.codex/plugins/documents',
  },
];

export const automationTasks: AutomationTask[] = [
  {
    id: 'health',
    title: 'BushServer 连接检查',
    cadence: '每 30 分钟',
    enabled: true,
  },
  {
    id: 'daily',
    title: '每日会话回顾',
    cadence: '每天 18:00',
    enabled: false,
  },
];
