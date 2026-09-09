import type { MenuItemConstructorOptions } from 'electron';

export interface FileContextMenuOptions {
  language?: 'zh' | 'en';
  image?: { x: number; y: number };
}

export function buildFileContextMenu(input: {
  path: string; exists: boolean; isFile: boolean; language?: 'zh' | 'en';
}, actions: {
  open?: () => void | Promise<unknown>;
  openWith: () => void | Promise<unknown>;
  reveal: () => void | Promise<unknown>;
  copyPath: () => void | Promise<unknown>;
  copyFile: () => void | Promise<unknown>;
  copyImage?: () => void | Promise<unknown>;
  onError: (error: unknown) => void;
}): MenuItemConstructorOptions[] {
  const en = input.language === 'en';
  const item = (label: string, labelEn: string, action: () => unknown, enabled = true): MenuItemConstructorOptions => ({
    label: en ? labelEn : label, enabled,
    click: () => { void Promise.resolve().then(action).catch(actions.onError); },
  });
  const items: MenuItemConstructorOptions[] = [];
  if (actions.copyImage) items.push(item('复制图片', 'Copy image', actions.copyImage));
  if (!input.path) return items;
  if (items.length) items.push({ type: 'separator' });
  if (!input.exists) items.push({ label: en ? 'File does not exist' : '文件不存在（无法打开）', enabled: false });
  if (actions.open) items.push(item('在 CardBush 中打开', 'Open in CardBush', actions.open, input.exists));
  items.push(
    item('打开方式...', 'Open with...', actions.openWith, input.exists),
    item('跳转到文件位置', 'Show in folder', actions.reveal, input.exists),
    { type: 'separator' },
    item('复制文件', 'Copy file', actions.copyFile, input.isFile),
    item('复制路径', 'Copy path', actions.copyPath),
  );
  return items;
}
