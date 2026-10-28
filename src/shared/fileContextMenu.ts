import { uiText } from '../i18n';
import type { MouseEvent } from 'react';
import { isAbsoluteLocalPath } from './localPaths';
import { showUiError } from './showUiError';

/** File actions use the original local file; completion means the native menu has closed. */
export function openFileContextMenu(event: MouseEvent<HTMLElement>, target: string,
  options: { language?: string } = {}) {
  const show = window.cardbushDesktop?.showFileContextMenu;
  if (!show) return; // Preserve the browser's own menu outside the desktop host.
  const localPath = isAbsoluteLocalPath(target) || /^(?:file|cardbush-file):/i.test(target) ? target : '';
  if (!localPath) return;
  event.preventDefault();
  event.stopPropagation();
  return show(localPath, { language: options.language }).then(error => {
    if (error) throw new Error(error);
  }).catch(error => showUiError(uiText(options.language)('fileContextMenu.unableToOpenFileMenu'), String(error instanceof Error ? error.message : error)));
}
