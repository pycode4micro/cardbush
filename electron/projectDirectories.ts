import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ProjectDirectoryRenameResult {
  previousPath: string;
  nextPath: string;
  changed: boolean;
}

const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export async function renameProjectDirectory(
  rootPath: string,
  requestedName: string,
): Promise<ProjectDirectoryRenameResult> {
  const sourcePath = String(rootPath ?? '').trim();
  if (!sourcePath) {
    throw new Error('Project folder path is required.');
  }
  const previousPath = path.resolve(sourcePath);
  const name = String(requestedName ?? '').trim();
  validateDirectoryName(name);
  if (path.parse(previousPath).root === previousPath) {
    throw new Error('A filesystem root cannot be renamed as a project.');
  }
  const source = await fs.promises.lstat(previousPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error('The project folder no longer exists.');
    throw error;
  });
  if (!source.isDirectory() || source.isSymbolicLink()) {
    throw new Error('Only a real project directory can be renamed.');
  }

  const parent = path.dirname(previousPath);
  const nextPath = path.join(parent, name);
  if (previousPath === nextPath) {
    return { previousPath, nextPath, changed: false };
  }
  const caseOnlyRename = process.platform === 'win32' &&
    previousPath.toLocaleLowerCase() === nextPath.toLocaleLowerCase();
  if (!caseOnlyRename && await pathExists(nextPath)) {
    throw new Error('A file or folder with the requested name already exists.');
  }

  if (!caseOnlyRename) {
    await fs.promises.rename(previousPath, nextPath);
    return { previousPath, nextPath, changed: true };
  }

  const temporaryPath = path.join(parent, `.cardbush-rename-${randomUUID()}`);
  await fs.promises.rename(previousPath, temporaryPath);
  try {
    await fs.promises.rename(temporaryPath, nextPath);
  } catch (error) {
    await fs.promises.rename(temporaryPath, previousPath).catch(() => undefined);
    throw error;
  }
  return { previousPath, nextPath, changed: true };
}

function validateDirectoryName(name: string): void {
  if (!name || name === '.' || name === '..') {
    throw new Error('Project folder name is required.');
  }
  if (name !== path.basename(name) || /[<>:"/\\|?*\u0000-\u001f]/.test(name)) {
    throw new Error('Project folder name contains unsupported characters.');
  }
  if (/[. ]$/.test(name) || windowsReservedName.test(name)) {
    throw new Error('Project folder name is reserved by Windows.');
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.promises.lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
