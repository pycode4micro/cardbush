import type { MouseEvent } from 'react';
import { isAbsoluteLocalPath } from './localPaths';
import { showUiError } from './showUiError';

/** File actions always use the original local file. */
export function openFileContextMenu(event: MouseEvent<HTMLElement>, target: string,
  options: { language?: 'zh' | 'en' } = {}) {
  const show = window.cardbushDesktop?.showFileContextMenu;
  if (!show) return; // Preserve the browser's own menu outside the desktop host.
  const localPath = isAbsoluteLocalPath(target) || /^(?:file|cardbush-file):/i.test(target) ? target : '';
  if (!localPath) return;
  event.preventDefault();
  event.stopPropagation();
  void show(localPath, { language: options.language }).then(error => {
    if (error) throw new Error(error);
  }).catch(error => showUiError(options.language === 'en' ? 'Unable to open file menu' : '无法打开文件菜单', String(error instanceof Error ? error.message : error)));
}
