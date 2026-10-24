import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { resolveProcessResourceHost } from './processResourceGuard.js';

/** OS account metadata, deliberately separate from AppContainer's private HOME. */
export async function userDirectories(signal?: AbortSignal) {
  signal?.throwIfAborted();
  let value: unknown = { home: homedir() };
  if (process.platform === 'win32') {
    const result = await promisify(execFile)(resolveProcessResourceHost(), ['--user-directories'], {
      windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024, signal,
    });
    value = JSON.parse(result.stdout);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid OS directory metadata.');
  const directories: Record<string, string> = {};
  for (const key of ['home', 'desktop', 'documents']) {
    const path = (value as Record<string, unknown>)[key];
    if (path === undefined || path === '') continue;
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw Error('Invalid OS directory path.');
    directories[key] = path;
  }
  return { executionEnvironment: { kind: 'local' }, directories,
    unavailable: ['home', 'desktop', 'documents'].filter(key => !directories[key]),
    accessGranted: false,
    nextStep: 'Use these OS account paths when the user refers to their desktop or documents. Missing folders are unavailable; do not guess. File access and moves still require the normal path authorization. Sandboxed HOME/USERPROFILE refers to a private task profile.' };
}
