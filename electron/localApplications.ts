import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { OpenDialogOptions } from 'electron';

export type LocalApplication = { id: string; title: string; path: string; icon?: string; iconVersion?: 1 };

export function localApplicationDialog(language: string, platform = process.platform): OpenDialogOptions {
  const zh = language === 'zh';
  return {
    title: zh ? '添加本地应用' : 'Add local app',
    properties: ['openFile', 'dontAddToRecent', 'noResolveAliases'],
    ...(platform === 'win32' ? { filters: [{ name: zh ? '桌面快捷方式' : 'Desktop shortcuts', extensions: ['lnk', 'url'] }, { name: zh ? '应用程序' : 'Applications', extensions: ['exe'] }] }
      : platform === 'darwin' ? { filters: [{ name: zh ? '应用程序' : 'Applications', extensions: ['app'] }] } : {}),
  };
}

export async function validateLocalApplication(value: unknown, platform = process.platform): Promise<string> {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || !paths.isAbsolute(value)
    || (platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(value))) throw Error('请选择应用程序的完整路径。 / Select an absolute application path.');
  const target = paths.normalize(value), extension = paths.extname(target).toLowerCase();
  const stats = await fs.stat(target).catch(() => null);
  if (!stats) throw Error('应用已移动或不存在，请重新添加。 / The app was moved or no longer exists. Add it again.');
  const supported = platform === 'win32' ? stats.isFile() && ['.exe', '.lnk', '.url'].includes(extension)
    : platform === 'darwin' ? stats.isDirectory() && extension === '.app'
    : stats.isFile() && (extension === '.desktop' || Boolean(stats.mode & 0o111));
  if (!supported) throw Error('请选择应用程序或应用快捷方式。 / Select an application or application shortcut.');
  return target;
}

export async function inspectLocalApplication(value: unknown, getIcon: (target: string) => Promise<string>, platform = process.platform): Promise<LocalApplication> {
  const target = await validateLocalApplication(value, platform), paths = platform === 'win32' ? path.win32 : path.posix;
  const identity = platform === 'win32' ? target.toLowerCase() : target;
  const icon = await getIcon(target).catch(() => '');
  return {
    id: `local:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`,
    title: paths.basename(target, paths.extname(target)), path: target,
    ...(icon.startsWith('data:image/png;base64,') && icon.length <= 131072 ? { icon, iconVersion: 1 as const } : {}),
  };
}

export async function launchLocalApplication(value: unknown, open: (target: string) => Promise<string>, platform = process.platform) {
  const target = await validateLocalApplication(value, platform);
  const error = await open(target);
  if (error) throw Error(error);
}
