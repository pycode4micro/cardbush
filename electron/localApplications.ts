import { uiText } from '@cardbush/platform/i18n';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { OpenDialogOptions } from 'electron';

export type LocalApplication = { id: string; title: string; path: string; icon?: string; iconVersion?: 1 };

export function localApplicationDialog(language: string, platform = process.platform): OpenDialogOptions {
  return {
    title: uiText(language)('appCenterSettingsMenu.addLocalApp'),
    properties: ['openFile', 'dontAddToRecent', 'noResolveAliases'],
    ...(platform === 'win32' ? { filters: [{ name: uiText(language)('localApplications.desktopShortcuts'), extensions: ['lnk', 'url'] }, { name: uiText(language)('localApplications.applications'), extensions: ['exe'] }] }
      : platform === 'darwin' ? { filters: [{ name: uiText(language)('localApplications.applications'), extensions: ['app'] }] } : {}),
  };
}

export async function validateLocalApplication(value: unknown, platform = process.platform, language = 'en'): Promise<string> {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || !paths.isAbsolute(value)
    || (platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(value))) throw Error(uiText(language)('localApplications.select_an_absolute_application_path'));
  const target = paths.normalize(value), extension = paths.extname(target).toLowerCase();
  const stats = await fs.stat(target).catch(() => null);
  if (!stats) throw Error(uiText(language)('localApplications.the_app_was_moved_or_no_longer'));
  const supported = platform === 'win32' ? stats.isFile() && ['.exe', '.lnk', '.url'].includes(extension)
    : platform === 'darwin' ? stats.isDirectory() && extension === '.app'
    : stats.isFile() && (extension === '.desktop' || Boolean(stats.mode & 0o111));
  if (!supported) throw Error(uiText(language)('localApplications.select_an_application_or_application_shortcut'));
  return target;
}

export async function inspectLocalApplication(value: unknown, getIcon: (target: string) => Promise<string>, platform = process.platform, language = 'en'): Promise<LocalApplication> {
  const target = await validateLocalApplication(value, platform, language), paths = platform === 'win32' ? path.win32 : path.posix;
  const identity = platform === 'win32' ? target.toLowerCase() : target;
  const icon = await getIcon(target).catch(() => '');
  return {
    id: `local:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`,
    title: paths.basename(target, paths.extname(target)), path: target,
    ...(icon.startsWith('data:image/png;base64,') && icon.length <= 131072 ? { icon, iconVersion: 1 as const } : {}),
  };
}

export async function launchLocalApplication(value: unknown, open: (target: string) => Promise<string>, platform = process.platform, language = 'en') {
  const target = await validateLocalApplication(value, platform, language);
  const error = await open(target);
  if (error) throw Error(error);
}
