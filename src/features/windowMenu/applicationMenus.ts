import type { WindowMenuAction } from '../../../electron/windowMenu';
import type { AppLanguage } from '../../types';
import type { ShortcutId } from '../shortcuts/keyboardShortcuts';
import { homepage } from '../../../package.json';

export type WindowMenuItem = {
  id: string; label: string; shortcut?: ShortcutId; keyLabel?: string;
  /** Search and recent-chat navigation also work without a title bar. */
  shortcutHandledElsewhere?: boolean;
  disabled?: boolean; checked?: boolean; nativeAction?: WindowMenuAction;
  onSelect?: () => void | Promise<unknown>; children?: WindowMenuEntry[];
};
export type WindowMenuEntry = WindowMenuItem | { separator: true };
export type ApplicationMenu = { id: string; label: string; items: WindowMenuEntry[] };
type Actions = {
  newConversation: () => void; openProject?: () => void; openFiles?: () => void;
  openSettings: () => void; showShortcuts: () => void; openDiagnostics: () => void;
  openAppCenter?: () => void; openPlugins?: () => void; openAutomations?: () => void;
  toggleSidebar: () => void; toggleInspector: () => void; search: () => void;
  openBrowser: () => void; focusBrowserAddress?: () => void; reloadBrowser?: () => void;
  openReview?: () => void; openHistory?: () => void; openShadow?: () => void;
  previousConversation?: () => void; back?: () => void; forward?: () => void; openTeam?: () => void;
};

/** Menu items route to existing application actions; no parallel command backend. */
export function applicationMenus(language: AppLanguage, actions: Actions, state: {
  sidebarVisible: boolean; inspectorVisible: boolean; native: boolean; externalLinks: boolean;
}): ApplicationMenu[] {
  const zh = language === 'zh';
  const label = (cn: string, en: string) => zh ? cn : en;
  const separator = { separator: true } as const;
  const item = (id: string, cn: string, en: string, onSelect?: WindowMenuItem['onSelect'], shortcut?: ShortcutId,
    extra: Partial<WindowMenuItem> = {}): WindowMenuItem =>
    ({ id, label: label(cn, en), onSelect, shortcut, disabled: !onSelect, ...extra });
  const native = (id: WindowMenuAction, cn: string, en: string, shortcut?: ShortcutId, keyLabel?: string): WindowMenuItem =>
    ({ id, label: label(cn, en), nativeAction: id, shortcut, keyLabel, disabled: !state.native });
  const external = (id: string, cn: string, en: string, suffix: string) => item(id, cn, en,
    state.externalLinks ? () => window.cardbushDesktop?.openExternal(homepage + suffix) : undefined);
  const menus: ApplicationMenu[] = [
    { id: 'file', label: label('文件', 'File'), items: [
      item('newConversation', '新会话', 'New chat', actions.newConversation, 'newConversation'), separator,
      item('openAppCenter', '应用中心', 'App center', actions.openAppCenter, 'openAppCenter'),
      { id: 'applications', label: label('应用', 'Applications'), children: [
        item('openPlugins', '插件', 'Plugins', actions.openPlugins, 'openPlugins'),
        item('openAutomations', '定时与自动化', 'Automations', actions.openAutomations, 'openAutomations'),
      ] }, separator,
      item('openProject', '打开文件夹…', 'Open folder…', actions.openProject, 'openProject'),
      item('openFiles', '打开文件…', 'Open files…', actions.openFiles, 'openFiles'), separator,
      native('close', '关闭窗口', 'Close window', 'closeWindow'),
      native('quit', '退出 CardBush', 'Quit CardBush', 'quitApp'),
    ] },
    { id: 'edit', label: label('编辑', 'Edit'), items: [
      native('undo', '撤销', 'Undo', undefined, 'Ctrl + Z'),
      native('redo', '重做', 'Redo', undefined, 'Ctrl + Y'), separator,
      native('cut', '剪切', 'Cut', undefined, 'Ctrl + X'),
      native('copy', '复制', 'Copy', undefined, 'Ctrl + C'),
      native('paste', '粘贴', 'Paste', undefined, 'Ctrl + V'),
      native('delete', '删除', 'Delete'), separator,
      native('selectAll', '全选', 'Select all', undefined, 'Ctrl + A'), separator,
      item('openSettings', '设置', 'Settings', actions.openSettings, 'openSettings'),
    ] },
    { id: 'view', label: label('视图', 'View'), items: [
      item('toggleSidebar', '切换侧边栏', 'Toggle sidebar', actions.toggleSidebar, 'toggleSidebar', { checked: state.sidebarVisible }),
      item('toggleInspector', '切换右侧栏', 'Toggle right sidebar', actions.toggleInspector, 'toggleInspector', { checked: state.inspectorVisible }),
      item('openReview', '打开审查', 'Open review', actions.openReview, 'openReview'),
      item('openHistory', '查看会话历史', 'View conversation history', actions.openHistory),
      item('openShadow', '打开 Shadow 对话', 'Open Shadow chat', actions.openShadow, 'openShadow'), separator,
      { id: 'browser', label: label('浏览器', 'Browser'), children: [
        item('openBrowser', '打开浏览器标签页', 'Open browser tab', actions.openBrowser, 'openBrowser'),
        item('focusBrowserAddress', '聚焦浏览器地址栏', 'Focus browser address', actions.focusBrowserAddress, 'focusBrowserAddress'),
        item('reloadBrowser', '重新加载页面', 'Reload page', actions.reloadBrowser, 'reloadBrowser'),
      ] }, separator,
      item('search', '查找', 'Find', actions.search, 'searchConversations', { shortcutHandledElsewhere: true }),
      item('previousConversation', '切回上个会话', 'Switch to previous chat', actions.previousConversation, 'previousConversation', { shortcutHandledElsewhere: true }),
      item('back', '返回', 'Back', actions.back, 'navigateBack'),
      item('forward', '前进', 'Forward', actions.forward, 'navigateForward'), separator,
      native('zoomIn', '放大', 'Zoom in', 'appZoomIn'),
      native('zoomOut', '缩小', 'Zoom out', 'appZoomOut'),
      native('resetZoom', '实际大小', 'Actual size', 'appZoomReset'), separator,
      native('toggleFullscreen', '切换全屏', 'Toggle full screen', 'toggleFullscreen'),
    ] },
    { id: 'help', label: label('帮助', 'Help'), items: [
      external('documentation', '文档', 'Documentation', '#readme'),
      item('showShortcuts', '显示键盘快捷键', 'Show keyboard shortcuts', actions.showShortcuts, 'showShortcuts'), separator,
      item('diagnostics', '诊断与关于', 'Diagnostics and about', actions.openDiagnostics),
      external('feedback', '反馈', 'Feedback', '/issues/new'),
      external('releases', '查看发布版本', 'View releases', '/releases'),
    ] },
  ];
  if (actions.openTeam) menus.push({ id: 'beta', label: 'Beta', items: [item('team', 'Team', 'Team', actions.openTeam)] });
  return menus;
}

export function windowMenuItems(menus: ApplicationMenu[]): WindowMenuItem[] {
  const flatten = (entries: WindowMenuEntry[]): WindowMenuItem[] => entries.flatMap(entry =>
    'separator' in entry ? [] : [entry, ...flatten(entry.children ?? [])]);
  return menus.flatMap(menu => flatten(menu.items));
}
