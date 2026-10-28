import { uiText, type MessageKey } from '../../i18n';
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
  previousConversation?: () => void; back?: () => void; forward?: () => void;
};

/** Menu items route to existing application actions; no parallel command backend. */
export function applicationMenus(language: AppLanguage, actions: Actions, state: {
  sidebarVisible: boolean; inspectorVisible: boolean; native: boolean; externalLinks: boolean;
}): ApplicationMenu[] {
  const separator = { separator: true } as const;
  const item = (id: string, message: MessageKey, onSelect?: WindowMenuItem['onSelect'], shortcut?: ShortcutId,
    extra: Partial<WindowMenuItem> = {}): WindowMenuItem =>
    ({ id, label: uiText(language)(message), onSelect, shortcut, disabled: !onSelect, ...extra });
  const native = (id: WindowMenuAction, message: MessageKey, shortcut?: ShortcutId, keyLabel?: string): WindowMenuItem =>
    ({ id, label: uiText(language)(message), nativeAction: id, shortcut, keyLabel, disabled: !state.native });
  const external = (id: string, message: MessageKey, suffix: string) => item(id, message,
    state.externalLinks ? () => window.cardbushDesktop?.openExternal(homepage + suffix) : undefined);
  const menus: ApplicationMenu[] = [
    { id: 'file', label: uiText(language)('reviewCommentModel.file'), items: [
      item('newConversation', 'conversationSearchDialog.newChat', actions.newConversation, 'newConversation'), separator,
      item('openAppCenter', 'appCenter.appCenter', actions.openAppCenter, 'openAppCenter'),
      { id: 'applications', label: uiText(language)('composer.applications'), children: [
        item('openPlugins', 'appCenterModel.plugins', actions.openPlugins, 'openPlugins'),
        item('openAutomations', 'appCenterModel.automations', actions.openAutomations, 'openAutomations'),
      ] }, separator,
      item('openProject', 'applicationMenus.open_folder', actions.openProject, 'openProject'),
      item('openFiles', 'applicationMenus.open_files', actions.openFiles, 'openFiles'), separator,
      native('close', 'keyboardShortcuts.closeWindow', 'closeWindow'),
      native('quit', 'keyboardShortcuts.quitCardbush', 'quitApp'),
    ] },
    { id: 'edit', label: uiText(language)('common.edit'), items: [
      native('undo', 'applicationMenus.undo', undefined, 'Ctrl + Z'),
      native('redo', 'applicationMenus.redo', undefined, 'Ctrl + Y'), separator,
      native('cut', 'applicationMenus.cut', undefined, 'Ctrl + X'),
      native('copy', 'messageBubble.copy', undefined, 'Ctrl + C'),
      native('paste', 'applicationMenus.paste', undefined, 'Ctrl + V'),
      native('delete', 'appCenter.delete'), separator,
      native('selectAll', 'applicationMenus.select_all', undefined, 'Ctrl + A'), separator,
      item('openSettings', 'cardlingWindow.settings', actions.openSettings, 'openSettings'),
    ] },
    { id: 'view', label: uiText(language)('applicationMenus.view'), items: [
      item('toggleSidebar', 'keyboardShortcuts.toggleSidebar', actions.toggleSidebar, 'toggleSidebar', { checked: state.sidebarVisible }),
      item('toggleInspector', 'keyboardShortcuts.toggleRightSidebar', actions.toggleInspector, 'toggleInspector', { checked: state.inspectorVisible }),
      item('openReview', 'keyboardShortcuts.openReview', actions.openReview, 'openReview'),
      item('openHistory', 'applicationMenus.view_conversation_history', actions.openHistory),
      item('openShadow', 'keyboardShortcuts.openShadowChat', actions.openShadow, 'openShadow'), separator,
      { id: 'browser', label: uiText(language)('settingsNavigation.browser'), children: [
        item('openBrowser', 'applicationMenus.open_browser_tab', actions.openBrowser, 'openBrowser'),
        item('focusBrowserAddress', 'keyboardShortcuts.focusBrowserAddress', actions.focusBrowserAddress, 'focusBrowserAddress'),
        item('reloadBrowser', 'keyboardShortcuts.reloadPage', actions.reloadBrowser, 'reloadBrowser'),
      ] }, separator,
      item('search', 'applicationMenus.find', actions.search, 'searchConversations', { shortcutHandledElsewhere: true }),
      item('previousConversation', 'keyboardShortcuts.switchToPreviousChat', actions.previousConversation, 'previousConversation', { shortcutHandledElsewhere: true }),
      item('back', 'windowFrame.back', actions.back, 'navigateBack'),
      item('forward', 'app.forward', actions.forward, 'navigateForward'), separator,
      native('zoomIn', 'image.zoomInHint', 'appZoomIn'),
      native('zoomOut', 'image.zoomOutHint', 'appZoomOut'),
      native('resetZoom', 'applicationMenus.actual_size', 'appZoomReset'), separator,
      native('toggleFullscreen', 'keyboardShortcuts.toggleFullScreen', 'toggleFullscreen'),
    ] },
    { id: 'help', label: uiText(language)('applicationMenus.help'), items: [
      external('documentation', 'applicationMenus.documentation', '#readme'),
      item('showShortcuts', 'keyboardShortcuts.showKeyboardShortcuts', actions.showShortcuts, 'showShortcuts'), separator,
      item('diagnostics', 'applicationMenus.diagnostics_and_about', actions.openDiagnostics),
      external('feedback', 'applicationMenus.feedback', '/issues/new'),
      external('releases', 'applicationMenus.view_releases', '/releases'),
    ] },
  ];
  return menus;
}

export function windowMenuItems(menus: ApplicationMenu[]): WindowMenuItem[] {
  const flatten = (entries: WindowMenuEntry[]): WindowMenuItem[] => entries.flatMap(entry =>
    'separator' in entry ? [] : [entry, ...flatten(entry.children ?? [])]);
  return menus.flatMap(menu => flatten(menu.items));
}
