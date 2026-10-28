import type { MessageKey } from '../../i18n';
import { uiText } from '../../i18n';
export type ShortcutBinding = { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean };
type ShortcutContext = 'composer' | 'queue' | 'transcript' | 'edit' | 'sidebar' | 'image';
type Text = MessageKey;
type ShortcutDefinition = {
  id: string; group: 'application' | 'conversation' | 'inspector' | 'image'; contexts: ShortcutContext[];
  title: Text; description: Text; defaultBinding: ShortcutBinding;
};
const appContexts: ShortcutContext[] = ['composer', 'queue', 'transcript', 'edit', 'sidebar'];

export const shortcutDefinitions = [
  { id: 'openAppCenter', group: 'application', contexts: appContexts, defaultBinding: { key: 'a', ctrl: true, shift: true },
    title: 'appCenter.appCenter', description: 'keyboardShortcuts.openApplicationsAndShortcuts' },
  { id: 'openPlugins', group: 'application', contexts: appContexts, defaultBinding: { key: 'p', ctrl: true, alt: true },
    title: 'appCenterModel.plugins', description: 'keyboardShortcuts.openPluginManagement' },
  { id: 'openAutomations', group: 'application', contexts: appContexts, defaultBinding: { key: 't', ctrl: true, alt: true },
    title: 'appCenterModel.automations', description: 'keyboardShortcuts.openTheCalendarAndScheduledTasks' },
  { id: 'extractConversation', group: 'conversation', contexts: appContexts, defaultBinding: { key: 'e', ctrl: true, shift: true },
    title: 'conversationExtraction.extractConversation', description: 'keyboardShortcuts.extractTheCurrentConversationAsMarkdown' },
  { id: 'newConversation', group: 'conversation', contexts: appContexts, defaultBinding: { key: 'n', ctrl: true },
    title: 'conversationSearchDialog.newChat', description: 'keyboardShortcuts.startANewConversation' },
  { id: 'openProject', group: 'application', contexts: appContexts, defaultBinding: { key: 'o', ctrl: true },
    title: 'conversationSearchDialog.openFolder', description: 'keyboardShortcuts.chooseAFolderToAddAsA' },
  { id: 'openSettings', group: 'application', contexts: appContexts, defaultBinding: { key: ',', ctrl: true },
    title: 'cardlingWindow.settings', description: 'keyboardShortcuts.openApplicationSettings' },
  { id: 'showShortcuts', group: 'application', contexts: appContexts, defaultBinding: { key: '/', ctrl: true },
    title: 'keyboardShortcuts.showKeyboardShortcuts', description: 'keyboardShortcuts.viewAndCustomizeKeyboardShortcuts' },
  { id: 'toggleSidebar', group: 'application', contexts: appContexts, defaultBinding: { key: 'b', ctrl: true },
    title: 'keyboardShortcuts.toggleSidebar', description: 'keyboardShortcuts.showOrHideTheLeftSidebar' },
  { id: 'toggleInspector', group: 'inspector', contexts: appContexts, defaultBinding: { key: 'b', ctrl: true, alt: true },
    title: 'keyboardShortcuts.toggleRightSidebar', description: 'keyboardShortcuts.showOrHideTheFileAndBrowser' },
  { id: 'navigateBack', group: 'application', contexts: appContexts, defaultBinding: { key: '[', ctrl: true },
    title: 'windowFrame.back', description: 'keyboardShortcuts.goBackThroughVisitedPagesAndConversations' },
  { id: 'navigateForward', group: 'application', contexts: appContexts, defaultBinding: { key: ']', ctrl: true },
    title: 'app.forward', description: 'keyboardShortcuts.goForwardThroughPageAndConversationHistory' },
  { id: 'focusBrowserAddress', group: 'inspector', contexts: appContexts, defaultBinding: { key: 'l', ctrl: true },
    title: 'keyboardShortcuts.focusBrowserAddress', description: 'keyboardShortcuts.editTheAddressOfTheCurrentBrowser' },
  { id: 'reloadBrowser', group: 'inspector', contexts: appContexts, defaultBinding: { key: 'r', ctrl: true },
    title: 'keyboardShortcuts.reloadPage', description: 'keyboardShortcuts.reloadTheCurrentPreviewPage' },
  { id: 'appZoomIn', group: 'application', contexts: appContexts, defaultBinding: { key: 'Plus', ctrl: true },
    title: 'keyboardShortcuts.zoomInterfaceIn', description: 'keyboardShortcuts.zoomTheAppImagePreviewsKeepTheir' },
  { id: 'appZoomOut', group: 'application', contexts: appContexts, defaultBinding: { key: 'Minus', ctrl: true },
    title: 'keyboardShortcuts.zoomInterfaceOut', description: 'keyboardShortcuts.zoomTheApplicationInterfaceOut' },
  { id: 'appZoomReset', group: 'application', contexts: appContexts, defaultBinding: { key: '0', ctrl: true },
    title: 'keyboardShortcuts.actualInterfaceSize', description: 'keyboardShortcuts.restoreTheDefaultInterfaceScale' },
  { id: 'toggleFullscreen', group: 'application', contexts: appContexts, defaultBinding: { key: 'F11' },
    title: 'keyboardShortcuts.toggleFullScreen', description: 'keyboardShortcuts.enterOrLeaveFullScreen' },
  { id: 'closeWindow', group: 'application', contexts: appContexts, defaultBinding: { key: 'w', ctrl: true },
    title: 'keyboardShortcuts.closeWindow', description: 'keyboardShortcuts.hideTheMainWindowAndKeepThe' },
  { id: 'quitApp', group: 'application', contexts: appContexts, defaultBinding: { key: 'q', ctrl: true },
    title: 'keyboardShortcuts.quitCardbush', description: 'keyboardShortcuts.quitTheApplication' },
  { id: 'searchConversations', group: 'conversation', contexts: appContexts, defaultBinding: { key: 'f', ctrl: true },
    title: 'conversationSearchDialog.searchChats',
    description: 'keyboardShortcuts.openChatSearchIncludingWhenTheSidebar' },
  { id: 'previousConversation', group: 'conversation', contexts: appContexts, defaultBinding: { key: 'Tab', ctrl: true },
    title: 'keyboardShortcuts.switchToPreviousChat',
    description: 'keyboardShortcuts.switchToTheLastVisitedChatPress' },
  { id: 'sendMessage', group: 'conversation', contexts: ['composer'], defaultBinding: { key: 'Enter' },
    title: 'keyboardShortcuts.sendMessage',
    description: 'keyboardShortcuts.duringATaskUseTheDeliveryPreference' },
  { id: 'guideNow', group: 'conversation', contexts: ['composer', 'queue', 'transcript'], defaultBinding: { key: 'Enter', ctrl: true },
    title: 'keyboardShortcuts.sendGuidanceNow',
    description: 'keyboardShortcuts.addTheDraftToTheCurrentTurn' },
  { id: 'toggleQueueLock', group: 'conversation', contexts: ['composer', 'queue', 'transcript'], defaultBinding: { key: 'l', ctrl: true, shift: true },
    title: 'keyboardShortcuts.lockUnlockGuidanceQueue',
    description: 'keyboardShortcuts.pauseOrResumeAutomaticDeliveryInThis' },
  { id: 'submitEdit', group: 'conversation', contexts: ['edit'], defaultBinding: { key: 'Enter', ctrl: true },
    title: 'keyboardShortcuts.submitMessageEdit',
    description: 'keyboardShortcuts.whileEditingAnExistingMessage' },
  { id: 'renameConversation', group: 'conversation', contexts: ['sidebar'], defaultBinding: { key: 'F2' },
    title: 'keyboardShortcuts.renameConversation',
    description: 'keyboardShortcuts.whenAConversationInTheSidebarIs' },
  { id: 'openReview', group: 'inspector', contexts: appContexts, defaultBinding: { key: 'g', ctrl: true, shift: true },
    title: 'keyboardShortcuts.openReview',
    description: 'keyboardShortcuts.reviewFileChangesInTheCurrentConversation' },
  { id: 'openFiles', group: 'inspector', contexts: appContexts, defaultBinding: { key: 'p', ctrl: true },
    title: 'conversationSearchDialog.openFiles',
    description: 'keyboardShortcuts.chooseFilesToOpenInTheRight' },
  { id: 'openBrowser', group: 'inspector', contexts: appContexts, defaultBinding: { key: 't', ctrl: true },
    title: 'keyboardShortcuts.newBrowserTab',
    description: 'keyboardShortcuts.openANewBrowserTabInThe' },
  { id: 'openShadow', group: 'inspector', contexts: appContexts, defaultBinding: { key: 's', ctrl: true, alt: true },
    title: 'keyboardShortcuts.openShadowChat',
    description: 'keyboardShortcuts.availableWhenTheCurrentConversationSupportsShadow' },
  { id: 'imageZoomIn', group: 'image', contexts: ['image'], defaultBinding: { key: 'Plus', ctrl: true },
    title: 'keyboardShortcuts.zoomImageIn', description: 'keyboardShortcuts.whileAnImagePreviewIsOpen' },
  { id: 'imageZoomOut', group: 'image', contexts: ['image'], defaultBinding: { key: 'Minus', ctrl: true },
    title: 'keyboardShortcuts.zoomImageOut', description: 'keyboardShortcuts.whileAnImagePreviewIsOpen' },
  { id: 'imageReset', group: 'image', contexts: ['image'], defaultBinding: { key: '0', ctrl: true },
    title: 'keyboardShortcuts.resetImageZoom', description: 'keyboardShortcuts.restoreTheInitialImageScale' },
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

export function bindingError(id: ShortcutId, binding: ShortcutBinding, language: string): string {

  if (binding.key === 'Escape' || binding.key === 'Tab' && (!binding.ctrl || binding.alt) || binding.key === 'F5' ||
      binding.ctrl && ['a', 'c', 'v', 'x', 'z', 'y', 'r'].includes(binding.key) && !(id === 'reloadBrowser' && binding.key === 'r') ||
      binding.alt && binding.key === 'F4' || binding.key === 'Enter' && binding.shift && !binding.ctrl && !binding.alt) {
    return uiText(language)('keyboardShortcuts.thisKeyIsReservedForEditingDismissal');
  }
  if (!binding.ctrl && !binding.alt && !/^F(?:[1-9]|1[0-2])$/.test(binding.key) && !(id === 'sendMessage' && binding.key === 'Enter' && !binding.shift)) {
    return uiText(language)('keyboardShortcuts.useCtrlOrAltOrAFunction');
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
