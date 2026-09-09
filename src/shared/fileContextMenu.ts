import type { MouseEvent } from 'react';
import { isAbsoluteLocalPath } from './localPaths';
import { showUiError } from './showUiError';

/** The native menu uses the original file for file actions and the displayed image for pixel copying. */
export function openFileContextMenu(event: MouseEvent<HTMLElement>, target: string,
  options: { image?: boolean; language?: 'zh' | 'en' } = {}) {
  const show = window.cardbushDesktop?.showFileContextMenu;
  if (!show) return; // Preserve the browser's own menu outside the desktop host.
  const localPath = isAbsoluteLocalPath(target) || /^(?:file|cardbush-file):/i.test(target) ? target : '';
  const element = options.image
    ? event.currentTarget instanceof HTMLImageElement ? event.currentTarget : event.currentTarget.querySelector('img')
    : null;
  const bounds = element?.getBoundingClientRect();
  const image = element?.complete && element.naturalWidth > 0 && bounds && bounds.width > 0 && bounds.height > 0
    ? { x: Math.round((Math.max(0, bounds.left) + Math.min(window.innerWidth, bounds.right)) / 2),
      y: Math.round((Math.max(0, bounds.top) + Math.min(window.innerHeight, bounds.bottom)) / 2) }
    : undefined;
  if (!localPath && !image) return;
  event.preventDefault();
  event.stopPropagation();
  void show(localPath, { image, language: options.language }).then(error => {
    if (error) throw new Error(error);
  }).catch(error => showUiError(options.language === 'en' ? 'Unable to open file menu' : '无法打开文件菜单', String(error instanceof Error ? error.message : error)));
}
