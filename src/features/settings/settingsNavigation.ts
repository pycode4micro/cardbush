import type { SettingsSection } from '../../types';

export type VisibleSettingsSection = Exclude<SettingsSection, 'companion' | 'subagents' | 'instructions' | 'about'>;
type LocalizedText = { zh: string; en: string };

export const settingsLabels: Record<VisibleSettingsSection, LocalizedText> = {
  general: { zh: '常规', en: 'General' },
  notifications: { zh: '通知', en: 'Notifications' },
  voice: { zh: '语音', en: 'Voice' },
  projects: { zh: '项目', en: 'Projects' },
  ssh: { zh: 'SSH 连接', en: 'SSH connections' },
  profile: { zh: '个性化', en: 'Personalization' },
  summary_for_user: { zh: '记忆与预测', en: 'Memory & predictions' },
  appearance: { zh: '外观', en: 'Appearance' },
  shortcuts: { zh: '快捷键', en: 'Keyboard shortcuts' },
  usage: { zh: '使用统计', en: 'Usage' },
  models: { zh: '模型管理', en: 'Models' },
  mcp: { zh: '插件', en: 'Plugins' },
  browser: { zh: '浏览器', en: 'Browser' },
  'computer-use': { zh: '电脑操控', en: 'Computer Use' },
  runtime: { zh: '运行环境', en: 'Runtime' },
  proxy: { zh: '网络代理', en: 'Network proxy' },
  cache: { zh: '数据与维护', en: 'Data & maintenance' },
  diagnostics: { zh: '诊断与关于', en: 'Diagnostics & about' },
};

export const settingsDescriptions: Record<VisibleSettingsSection, LocalizedText> = {
  general: { zh: '设置界面语言和日常对话的交互方式。', en: 'Set the interface language and everyday conversation behavior.' },
  notifications: { zh: '设置回复完成、需要确认和发生错误时的提醒。', en: 'Manage alerts for completed responses, requests for input, and errors.' },
  voice: { zh: '配置录音转文字、语音通话和 Agent 音色。', en: 'Configure transcription, voice calls, and the Agent voice.' },
  projects: { zh: '管理当前 Agent 的项目目录和默认项目。', en: 'Manage this Agent’s project directories and default project.' },
  ssh: { zh: '管理远程主机，通过项目或 @ 引用接入。', en: 'Manage remote hosts for projects and @ references.' },
  profile: { zh: '调整回复风格和全局指令。', en: 'Set the response style and shared instructions.' },
  summary_for_user: { zh: '管理用户习惯、下一步预测和记忆总结。', en: 'Manage habits, next-step predictions, and memory summaries.' },
  appearance: { zh: '调整主题、颜色、字体和显示效果。', en: 'Adjust themes, colors, typography, and display effects.' },
  shortcuts: { zh: '查看和自定义快捷键，让操作更顺手。', en: 'View and customize keyboard shortcuts.' },
  usage: { zh: '查看实际记录的 Token 用量和使用活动。', en: 'Review recorded token usage and activity.' },
  models: { zh: '管理模型服务、输入能力和上下文长度。', en: 'Manage model services, input capabilities, and context limits.' },
  mcp: { zh: '管理插件、技能和应用连接。', en: 'Manage plugins, skills, and app connections.' },
  browser: { zh: '设置默认主页、Browser Use、Chrome 和 Edge 连接。', en: 'Configure the start page and Browser Use connections for Chrome and Edge.' },
  'computer-use': { zh: '管理桌面控制、截图和用户输入优先设置。', en: 'Manage desktop control, screenshots, and user input priority.' },
  runtime: { zh: '检测和安装沙盒，管理命令隔离与默认终端。', en: 'Check and install the sandbox, manage command isolation and the default terminal.' },
  proxy: { zh: '管理模型、插件市场及 MCP 的网络连接。', en: 'Manage connections for models, the plugin marketplace, and MCP.' },
  cache: { zh: '恢复归档条目，管理当前环境的数据、日志和缓存。', en: 'Restore archived items and manage data, logs, and cache in the selected environment.' },
  diagnostics: { zh: '检查运行状态，查看版本和环境信息。', en: 'Check runtime health, version, and environment information.' },
};

export const settingsNavigationGroups: Array<{ label: LocalizedText; sections: VisibleSettingsSection[] }> = [
  { label: { zh: '个人', en: 'Personal' }, sections: ['general', 'notifications', 'appearance', 'voice', 'profile', 'summary_for_user', 'shortcuts', 'usage', 'cache'] },
  { label: { zh: '集成', en: 'Integrations' }, sections: ['mcp', 'models', 'browser', 'computer-use'] },
  { label: { zh: '系统', en: 'System' }, sections: ['ssh', 'runtime', 'proxy', 'diagnostics'] },
];

const keywords: Record<VisibleSettingsSection, string> = {
  general: '语言 中文 English 对话 交互 引导 排队 队列 思考 消息 发送 general language interaction guidance queue thinking messages send',
  notifications: '消息 提醒 音效 音量 声音 通知 回复 完成 确认 错误 notification sound volume alerts response approval error',
  voice: '语音 通话 录音 转写 男声 女声 麦克风 音色 voice audio speech microphone transcription call TTS',
  summary_for_user: '习惯 记忆 预测 命中 总结 压缩 阈值 Token summary_for_user check_habit memory habit prediction summary threshold consolidation',
  projects: '项目 工作区 目录 project workspace directory',
  ssh: 'SSH 远程 连接 主机 服务器 私钥 项目 remote connection server key project',
  profile: '对话 风格 角色 自然 专业 直率 简短 自定义 语气 全局约束 AGENTS.md 提示词 instructions tone persona style natural professional direct concise',
  appearance: '主题 深色 浅色 系统 窗口 玻璃 透明 导入 字体 字号 强调色 背景 前景 对比度 动画 指针 差异 theme font size color background foreground accent contrast motion cursor diff glass',
  shortcuts: '快捷键 键盘 按键 引导 发送 排队 Ctrl Enter keyboard shortcuts hotkeys guidance queue',
  usage: '统计 Token 用量 活跃 热力图 会话次数 usage activity',
  models: '模型 API key 密钥 服务商 上下文 输出 视觉 图片 provider context vision',
  mcp: '插件 市场 技能 账号 授权 浏览器 Chrome MCP skills marketplace accounts OAuth search browser',
  browser: '浏览器 Browser Use Chrome Edge 主页 初始页 Google 扩展 权限 登录 连接 browser home start page extension',
  'computer-use': '电脑 桌面 操控 截图 鼠标 键盘 用户输入 computer desktop screenshot pointer',
  runtime: '沙盒 安装 检测 环境 隔离 权限 终端 命令 PowerShell WSL Bash sandbox install permissions terminal runtime',
  proxy: '代理 网络 插件市场 MCP HTTP HTTPS SOCKS NO_PROXY proxy network',
  cache: '归档 会话 项目 清理 删除 历史 日志 缓存 恢复 重置 配置包 archive archived chats projects cache history logs reset restore',
  diagnostics: '诊断 关于 版本 状态 检查 环境 Runtime Product Host version about health',
};

export function settingsSectionMatchesQuery(section: VisibleSettingsSection, query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = `${settingsLabels[section].zh} ${settingsLabels[section].en} ${settingsDescriptions[section].zh} ${settingsDescriptions[section].en} ${keywords[section]}`.toLocaleLowerCase();
  return terms.every(term => text.includes(term));
}

export function visibleSettingsSection(value: SettingsSection): VisibleSettingsSection {
  if (value === 'about') return 'diagnostics';
  if (value === 'instructions' || value === 'companion' || value === 'subagents') return 'profile';
  return value;
}
