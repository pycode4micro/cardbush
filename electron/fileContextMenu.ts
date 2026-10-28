import { uiText, type MessageKey } from '@cardbush/platform/i18n';
import type { MenuItemConstructorOptions } from 'electron';

export interface FileContextMenuOptions {
  language?: string;
}

export function buildFileContextMenu(input: {
  path: string; exists: boolean; isFile: boolean; language?: string;
}, actions: {
  open?: () => void | Promise<unknown>;
  openWith: () => void | Promise<unknown>;
  reveal: () => void | Promise<unknown>;
  copyPath: () => void | Promise<unknown>;
  copyFile: () => void | Promise<unknown>;
  onError: (error: unknown) => void;
}): MenuItemConstructorOptions[] {
  const t = uiText(input.language ?? 'zh');
  const item = (message: MessageKey, action: () => unknown, enabled = true): MenuItemConstructorOptions => ({
    label: t(message), enabled,
    click: () => { void Promise.resolve().then(action).catch(actions.onError); },
  });
  const items: MenuItemConstructorOptions[] = [];
  if (!input.path) return items;
  if (!input.exists) items.push({ label: t('fileContextMenu.file_does_not_exist'), enabled: false });
  if (actions.open) items.push(item('fileContextMenu.open_in_cardbush', actions.open, input.exists));
  items.push(
    item('fileContextMenu.open_with', actions.openWith, input.exists),
    item('fileContextMenu.show_in_folder', actions.reveal, input.exists),
    { type: 'separator' },
    item('fileContextMenu.copy_file', actions.copyFile, input.isFile),
    item('fileContextMenu.copy_path', actions.copyPath),
  );
  return items;
}
