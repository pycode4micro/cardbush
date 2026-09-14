import type { SettingsSection } from '../../types';

export type VisibleSettingsSection = Exclude<SettingsSection, 'companion' | 'subagents' | 'instructions' | 'about' | 'browser'>;
type LocalizedText = { zh: string; en: string };

export const settingsLabels: Record<VisibleSettingsSection, LocalizedText> = {
  profile: { zh: '个性化', en: 'Personalization' },
  appearance: { zh: '外观与语言', en: 'Appearance & language' },
  shortcuts: { zh: '快捷键', en: 'Keyboard shortcuts' },
  usage: { zh: '使用统计', en: 'Usage' },
  models: { zh: '模型管理', en: 'Models' },
  mcp: { zh: '插件', en: 'Plugins' },
  runtime: { zh: '运行环境', en: 'Runtime' },
  proxy: { zh: '网络代理', en: 'Network proxy' },
  cache: { zh: '数据与维护', en: 'Data & maintenance' },
  diagnostics: { zh: '诊断与关于', en: 'Diagnostics & about' },
};

export const settingsDescriptions: Record<VisibleSettingsSection, LocalizedText> = {
  profile: { zh: '调整对话语气、交互方式和长期偏好。', en: 'Set the conversation tone, interaction preferences, and shared instructions.' },
  appearance: { zh: '选择主题、界面语言和字体。', en: 'Choose your theme, interface language, and font.' },
  shortcuts: { zh: '查看和自定义快捷键，让操作更顺手。', en: 'View and customize keyboard shortcuts.' },
  usage: { zh: '查看实际记录的 Token 用量和使用活动。', en: 'Review recorded token usage and activity.' },
  models: { zh: '管理模型服务、输入能力和上下文长度。', en: 'Manage model services, input capabilities, and context limits.' },
  mcp: { zh: '管理插件、技能和应用连接。', en: 'Manage plugins, skills, and app connections.' },
  runtime: { zh: '选择工具执行命令时使用的终端。', en: 'Choose the terminal used by tools to run commands.' },
  proxy: { zh: '管理模型、插件市场及 MCP 的网络连接。', en: 'Manage connections for models, the plugin marketplace, and MCP.' },
  cache: { zh: '管理对话数据、日志和内置配置。', en: 'Manage conversation data, logs, and bundled configuration.' },
  diagnostics: { zh: '检查运行状态，查看版本和环境信息。', en: 'Check runtime health, version, and environment information.' },
};

export const settingsNavigationGroups: Array<{ label: LocalizedText; sections: VisibleSettingsSection[] }> = [
  { label: { zh: '能力', en: 'Capabilities' }, sections: ['mcp', 'models'] },
  { label: { zh: '偏好', en: 'Preferences' }, sections: ['profile', 'shortcuts', 'usage', 'appearance'] },
  { label: { zh: '系统', en: 'System' }, sections: ['runtime', 'proxy', 'cache', 'diagnostics'] },
];

const keywords: Record<VisibleSettingsSection, string> = {
  profile: '对话 风格 自然 专业 简短 自定义 语气 全局约束 AGENTS.md 提示词 引导 排队 队列 思考 instructions tone style guidance queue thinking',
  appearance: '主题 深色 浅色 赛博朋克 窗口 玻璃 导入 字体 中文 English theme font language glass',
  shortcuts: '快捷键 键盘 按键 引导 发送 排队 Ctrl Enter keyboard shortcuts hotkeys guidance queue',
  usage: '统计 Token 用量 活跃 热力图 会话次数 usage activity',
  models: '模型 API key 密钥 服务商 上下文 输出 视觉 图片 provider context vision',
  mcp: '插件 市场 技能 账号 授权 浏览器 Chrome MCP skills marketplace accounts OAuth search browser',
  runtime: '终端 命令 PowerShell WSL Bash terminal runtime',
  proxy: '代理 网络 插件市场 MCP HTTP HTTPS SOCKS NO_PROXY proxy network',
  cache: '清理 删除 历史 日志 缓存 恢复 重置 配置包 cache history logs reset restore',
  diagnostics: '诊断 关于 版本 状态 检查 环境 Runtime Product Host version about health',
};

export function settingsSectionMatchesQuery(section: VisibleSettingsSection, query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = `${settingsLabels[section].zh} ${settingsLabels[section].en} ${settingsDescriptions[section].zh} ${settingsDescriptions[section].en} ${keywords[section]}`.toLocaleLowerCase();
  return terms.every(term => text.includes(term));
}

export function visibleSettingsSection(value: SettingsSection): VisibleSettingsSection {
  if (value === 'browser') return 'mcp';
  if (value === 'about') return 'diagnostics';
  if (value === 'instructions' || value === 'companion' || value === 'subagents') return 'profile';
  return value;
}
