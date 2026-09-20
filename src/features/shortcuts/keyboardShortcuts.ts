export type ShortcutBinding = { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean };
type ShortcutContext = 'composer' | 'queue' | 'transcript' | 'edit' | 'sidebar' | 'image';
type Text = { zh: string; en: string };
type ShortcutDefinition = {
  id: string; group: 'application' | 'conversation' | 'inspector' | 'image'; contexts: ShortcutContext[];
  title: Text; description: Text; defaultBinding: ShortcutBinding;
};
const appContexts: ShortcutContext[] = ['composer', 'queue', 'transcript', 'edit', 'sidebar'];

export const shortcutDefinitions = [
  { id: 'extractConversation', group: 'conversation', contexts: appContexts, defaultBinding: { key: 'e', ctrl: true, shift: true },
    title: { zh: '提取对话', en: 'Extract conversation' }, description: { zh: '打开当前会话的提取弹窗。', en: 'Extract the current conversation as Markdown.' } },
  { id: 'newConversation', group: 'conversation', contexts: appContexts, defaultBinding: { key: 'n', ctrl: true },
    title: { zh: '新会话', en: 'New chat' }, description: { zh: '开始一个新会话。', en: 'Start a new conversation.' } },
  { id: 'openProject', group: 'application', contexts: appContexts, defaultBinding: { key: 'o', ctrl: true },
    title: { zh: '打开文件夹', en: 'Open folder' }, description: { zh: '选择文件夹并添加为项目。', en: 'Choose a folder to add as a project.' } },
  { id: 'openSettings', group: 'application', contexts: appContexts, defaultBinding: { key: ',', ctrl: true },
    title: { zh: '设置', en: 'Settings' }, description: { zh: '打开应用设置。', en: 'Open application settings.' } },
  { id: 'showShortcuts', group: 'application', contexts: appContexts, defaultBinding: { key: '/', ctrl: true },
    title: { zh: '显示键盘快捷键', en: 'Show keyboard shortcuts' }, description: { zh: '查看和修改快捷键。', en: 'View and customize keyboard shortcuts.' } },
  { id: 'toggleSidebar', group: 'application', contexts: appContexts, defaultBinding: { key: 'b', ctrl: true },
    title: { zh: '切换侧边栏', en: 'Toggle sidebar' }, description: { zh: '展开或收起左侧栏。', en: 'Show or hide the left sidebar.' } },
  { id: 'toggleInspector', group: 'inspector', contexts: appContexts, defaultBinding: { key: 'b', ctrl: true, alt: true },
    title: { zh: '切换右侧栏', en: 'Toggle right sidebar' }, description: { zh: '展开或收起文件与浏览器预览。', en: 'Show or hide the file and browser preview.' } },
  { id: 'navigateBack', group: 'conversation', contexts: appContexts, defaultBinding: { key: '[', ctrl: true },
    title: { zh: '返回', en: 'Back' }, description: { zh: '返回访问过的会话。', en: 'Go back through visited conversations.' } },
  { id: 'navigateForward', group: 'conversation', contexts: appContexts, defaultBinding: { key: ']', ctrl: true },
    title: { zh: '前进', en: 'Forward' }, description: { zh: '前进到返回前的会话。', en: 'Go forward through conversation history.' } },
  { id: 'focusBrowserAddress', group: 'inspector', contexts: appContexts, defaultBinding: { key: 'l', ctrl: true },
    title: { zh: '聚焦浏览器地址栏', en: 'Focus browser address' }, description: { zh: '编辑当前浏览器标签页的网址。', en: 'Edit the address of the current browser tab.' } },
  { id: 'reloadBrowser', group: 'inspector', contexts: appContexts, defaultBinding: { key: 'r', ctrl: true },
    title: { zh: '重新加载页面', en: 'Reload page' }, description: { zh: '刷新当前预览页面。', en: 'Reload the current preview page.' } },
  { id: 'appZoomIn', group: 'application', contexts: appContexts, defaultBinding: { key: 'Plus', ctrl: true },
    title: { zh: '放大界面', en: 'Zoom interface in' }, description: { zh: '放大整个应用界面；图片预览中优先缩放图片。', en: 'Zoom the app; image previews keep their own zoom controls.' } },
  { id: 'appZoomOut', group: 'application', contexts: appContexts, defaultBinding: { key: 'Minus', ctrl: true },
    title: { zh: '缩小界面', en: 'Zoom interface out' }, description: { zh: '缩小整个应用界面。', en: 'Zoom the application interface out.' } },
  { id: 'appZoomReset', group: 'application', contexts: appContexts, defaultBinding: { key: '0', ctrl: true },
    title: { zh: '界面实际大小', en: 'Actual interface size' }, description: { zh: '恢复应用默认缩放。', en: 'Restore the default interface scale.' } },
  { id: 'toggleFullscreen', group: 'application', contexts: appContexts, defaultBinding: { key: 'F11' },
    title: { zh: '切换全屏', en: 'Toggle full screen' }, description: { zh: '进入或退出全屏。', en: 'Enter or leave full screen.' } },
  { id: 'closeWindow', group: 'application', contexts: appContexts, defaultBinding: { key: 'w', ctrl: true },
    title: { zh: '关闭窗口', en: 'Close window' }, description: { zh: '隐藏主窗口，应用继续在托盘运行。', en: 'Hide the main window and keep the app running in the tray.' } },
  { id: 'quitApp', group: 'application', contexts: appContexts, defaultBinding: { key: 'q', ctrl: true },
    title: { zh: '退出 CardBush', en: 'Quit CardBush' }, description: { zh: '退出应用。', en: 'Quit the application.' } },
  { id: 'searchConversations', group: 'conversation', contexts: appContexts, defaultBinding: { key: 'f', ctrl: true },
    title: { zh: '搜索会话', en: 'Search chats' },
    description: { zh: '打开会话搜索，侧栏收起时也可使用。', en: 'Open chat search, including when the sidebar is collapsed.' } },
  { id: 'previousConversation', group: 'conversation', contexts: appContexts, defaultBinding: { key: 'Tab', ctrl: true },
    title: { zh: '切回上个会话', en: 'Switch to previous chat' },
    description: { zh: '切回上一个访问的会话，再按一次可切回来。', en: 'Switch to the last visited chat. Press again to switch back.' } },
  { id: 'sendMessage', group: 'conversation', contexts: ['composer'], defaultBinding: { key: 'Enter' },
    title: { zh: '发送消息', en: 'Send message' },
    description: { zh: '任务运行时，遵循个性化中的发送方式。', en: 'During a task, use the delivery preference in Personalization.' } },
  { id: 'guideNow', group: 'conversation', contexts: ['composer', 'queue', 'transcript'], defaultBinding: { key: 'Enter', ctrl: true },
    title: { zh: '立即引导', en: 'Send guidance now' },
    description: { zh: '将草稿加入当前回合；草稿为空或焦点在队列中时，发送队列第一条。', en: 'Add the draft to the current turn. Use the first queued message when the draft is empty or the queue is focused.' } },
  { id: 'submitEdit', group: 'conversation', contexts: ['edit'], defaultBinding: { key: 'Enter', ctrl: true },
    title: { zh: '提交消息修改', en: 'Submit message edit' },
    description: { zh: '编辑已有提问时生效。', en: 'While editing an existing message.' } },
  { id: 'renameConversation', group: 'conversation', contexts: ['sidebar'], defaultBinding: { key: 'F2' },
    title: { zh: '重命名会话', en: 'Rename conversation' },
    description: { zh: '左侧会话条目获得焦点时生效。', en: 'When a conversation in the sidebar is focused.' } },
  { id: 'openReview', group: 'inspector', contexts: appContexts, defaultBinding: { key: 'g', ctrl: true, shift: true },
    title: { zh: '打开审查', en: 'Open review' },
    description: { zh: '查看当前会话的文件修改。', en: 'Review file changes in the current conversation.' } },
  { id: 'openFiles', group: 'inspector', contexts: appContexts, defaultBinding: { key: 'p', ctrl: true },
    title: { zh: '打开文件', en: 'Open files' },
    description: { zh: '选择文件并在右侧栏打开。', en: 'Choose files to open in the right sidebar.' } },
  { id: 'openBrowser', group: 'inspector', contexts: appContexts, defaultBinding: { key: 't', ctrl: true },
    title: { zh: '新建浏览器标签', en: 'New browser tab' },
    description: { zh: '在右侧栏打开新的浏览器标签。', en: 'Open a new browser tab in the right sidebar.' } },
  { id: 'openShadow', group: 'inspector', contexts: appContexts, defaultBinding: { key: 's', ctrl: true, alt: true },
    title: { zh: '打开 Shadow 对话', en: 'Open Shadow chat' },
    description: { zh: '在当前会话支持 Shadow 时生效。', en: 'Available when the current conversation supports Shadow.' } },
  { id: 'imageZoomIn', group: 'image', contexts: ['image'], defaultBinding: { key: 'Plus', ctrl: true },
    title: { zh: '放大图片', en: 'Zoom image in' }, description: { zh: '图片预览打开时生效。', en: 'While an image preview is open.' } },
  { id: 'imageZoomOut', group: 'image', contexts: ['image'], defaultBinding: { key: 'Minus', ctrl: true },
    title: { zh: '缩小图片', en: 'Zoom image out' }, description: { zh: '图片预览打开时生效。', en: 'While an image preview is open.' } },
  { id: 'imageReset', group: 'image', contexts: ['image'], defaultBinding: { key: '0', ctrl: true },
    title: { zh: '重置图片比例', en: 'Reset image zoom' }, description: { zh: '恢复图片的初始显示比例。', en: 'Restore the initial image scale.' } },
] as const satisfies readonly ShortcutDefinition[];

export type ShortcutId = typeof shortcutDefinitions[number]['id'];
export type ShortcutOverrides = Partial<Record<ShortcutId, ShortcutBinding | null>>;
export type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> &
  Partial<Pick<KeyboardEvent, 'code' | 'repeat' | 'isComposing' | 'keyCode'>>;

export function bindingFromEvent(event: ShortcutEvent): ShortcutBinding | null {
  if (event.isComposing || event.keyCode === 229 || ['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'Dead', 'Process', 'Unidentified'].includes(event.key)) return null;
  let key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (['+', '='].includes(key) || event.code === 'NumpadAdd') key = 'Plus';
  if (['-', '_'].includes(key) || event.code === 'NumpadSubtract') key = 'Minus';
  return { key, ctrl: event.ctrlKey || event.metaKey, alt: event.altKey,
    shift: key === 'Plus' || key === 'Minus' ? false : event.shiftKey };
}

export function sameBinding(a: ShortcutBinding | null, b: ShortcutBinding | null) {
  return a === b || Boolean(a && b && a.key === b.key && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift);
}

export function shortcutBinding(id: ShortcutId, overrides: ShortcutOverrides): ShortcutBinding | null {
  return Object.hasOwn(overrides, id) ? overrides[id] ?? null : shortcutDefinitions.find(item => item.id === id)!.defaultBinding;
}

export function matchesShortcut(id: ShortcutId, event: ShortcutEvent, overrides: ShortcutOverrides) {
  if (event.repeat) return false;
  const binding = shortcutBinding(id, overrides);
  return binding !== null && sameBinding(binding, bindingFromEvent(event));
}

export function formatShortcut(binding: ShortcutBinding | null) {
  if (!binding) return '';
  const key = binding.key === 'Plus' ? '+' : binding.key === 'Minus' ? '-' : binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
  return [binding.ctrl && 'Ctrl', binding.alt && 'Alt', binding.shift && 'Shift', key].filter(Boolean).join(' + ');
}

export function shortcutAria(binding: ShortcutBinding | null) {
  return binding ? formatShortcut(binding).replaceAll(' + ', '+').replace('Ctrl', 'Control') : undefined;
}

export function bindingError(id: ShortcutId, binding: ShortcutBinding, language: 'zh' | 'en'): string {
  const zh = language === 'zh';
  if (binding.key === 'Escape' || binding.key === 'Tab' && (!binding.ctrl || binding.alt) || binding.key === 'F5' ||
      binding.ctrl && ['a', 'c', 'v', 'x', 'z', 'y', 'r'].includes(binding.key) && !(id === 'reloadBrowser' && binding.key === 'r') ||
      binding.alt && binding.key === 'F4' || binding.key === 'Enter' && binding.shift && !binding.ctrl && !binding.alt) {
    return zh ? '这个按键保留给换行、取消或系统操作，请换一个组合。' : 'This key is reserved for editing, dismissal, or system actions. Choose another combination.';
  }
  if (!binding.ctrl && !binding.alt && !/^F(?:[1-9]|1[0-2])$/.test(binding.key) && !(id === 'sendMessage' && binding.key === 'Enter' && !binding.shift)) {
    return zh ? '请搭配 Ctrl 或 Alt，或使用功能键 F1–F12。' : 'Use Ctrl or Alt, or a function key from F1 to F12.';
  }
  return '';
}

export function conflictingShortcut(id: ShortcutId, binding: ShortcutBinding | null, overrides: ShortcutOverrides) {
  if (!binding) return undefined;
  const contexts: readonly ShortcutContext[] = shortcutDefinitions.find(item => item.id === id)!.contexts;
  return shortcutDefinitions.find(item => item.id !== id && item.contexts.some(context => contexts.includes(context)) && sameBinding(binding, shortcutBinding(item.id, overrides)));
}

export function normalizeShortcutOverrides(value: unknown): ShortcutOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: ShortcutOverrides = {};
  for (const item of shortcutDefinitions) {
    const binding = (value as Record<string, unknown>)[item.id];
    if (binding === null) { result[item.id] = null; continue; }
    if (!binding || typeof binding !== 'object') continue;
    const candidate = binding as Record<string, unknown>;
    if (typeof candidate.key !== 'string' || !/^(?:[a-z0-9]|Enter|Tab|Space|Plus|Minus|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|[.,/;\[\]\\'`])$/.test(candidate.key)) continue;
    const normalized = { key: candidate.key, ctrl: candidate.ctrl === true, alt: candidate.alt === true, shift: candidate.shift === true };
    if (!bindingError(item.id, normalized, 'en') && !sameBinding(normalized, item.defaultBinding)) result[item.id] = normalized;
  }
  // Hand-edited or older settings must not cause one gesture to run two actions.
  for (const item of shortcutDefinitions) {
    if (Object.hasOwn(result, item.id) && conflictingShortcut(item.id, shortcutBinding(item.id, result), result)) result[item.id] = null;
  }
  return result;
}
