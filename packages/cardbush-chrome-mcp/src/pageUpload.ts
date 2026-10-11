import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { ChromeConnectorError } from './bridgeClient.js';
import type { PageCommand } from './pageCapture.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Select local files using Chromium's native input path, without reading file bytes into the model or page script. */
export async function uploadFiles(command: PageCommand, input: { uid?: string; selector?: string; filePaths: string[] }, signal?: AbortSignal) {
  const files = await Promise.all(input.filePaths.map(async filePath => {
    if (!path.isAbsolute(filePath) || filePath.includes('\0')) {
      throw new ChromeConnectorError('invalid_upload_path', 'Use absolute paths to existing files on this browser host.');
    }
    const absolute = path.normalize(filePath);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) throw new Error('Not a regular file');
      await access(absolute, constants.R_OK);
      return { path: absolute, name: path.basename(absolute), size: info.size };
    } catch {
      throw new ChromeConnectorError('upload_file_unavailable', `The upload file is not a readable regular file: ${absolute}`);
    }
  }));
  signal?.throwIfAborted();
  let objectId: string | undefined;
  try {
    const resolved = object(input.uid
      ? await command('DOM.resolveNode', { backendNodeId: Number(input.uid.slice(3)) })
      : await command('Runtime.evaluate', { expression: `(() => {
          const inputs = document.querySelectorAll(${JSON.stringify(input.selector)});
          if (inputs.length !== 1) throw new Error('Expected exactly one upload control; found ' + inputs.length + '. Inspect the page and use a more specific selector.');
          return inputs[0];
        })()`, returnByValue: false }));
    const remote = object(input.uid ? resolved.object : resolved.result);
    if (typeof remote.objectId === 'string') objectId = remote.objectId;
    if (resolved.exceptionDetails || !objectId) {
      throw new ChromeConnectorError('upload_target_missing', 'The upload target is missing or ambiguous. Inspect the page and choose one file input; hidden inputs can be selected with an observed CSS selector.');
    }
    const inspected = object(await command('Runtime.callFunctionOn', { objectId, returnByValue: true,
      functionDeclaration: `function() { return {
        fileInput: this.tagName === 'INPUT' && this.type === 'file', connected: this.isConnected,
        disabled: this.matches(':disabled'), directory: Boolean(this.webkitdirectory), multiple: Boolean(this.multiple)
      }; }` }));
    const control = object(object(inspected.result).value);
    if (inspected.exceptionDetails || !control.fileInput || !control.connected || control.disabled || control.directory) {
      throw new ChromeConnectorError('upload_target_invalid', 'Choose a connected, enabled input[type=file]. Directory selection is not supported. For a native file dialog or custom control, use Computer Use on the same browser window, then verify the page.');
    }
    if (files.length > 1 && !control.multiple) {
      throw new ChromeConnectorError('upload_multiple_not_allowed', 'This file input accepts one file. Select a single file or inspect a multiple-file input.');
    }
    signal?.throwIfAborted();
    try {
      // Chromium fires the input/change events. Do not dispatch duplicates or automatically submit the form.
      await command('DOM.setFileInputFiles', { objectId, files: files.map(file => file.path) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ChromeConnectorError('upload_selection_unconfirmed',
        'File selection could not be confirmed. It may already have reached the page; inspect its upload status before retrying or using Computer Use.',
        { execution: 'unknown', cause: error instanceof Error ? error.message : String(error) });
    }
    let selected: unknown;
    try {
      const checked = object(await command('Runtime.callFunctionOn', { objectId, returnByValue: true,
        functionDeclaration: 'function() { return Array.from(this.files || [], file => ({ name: file.name, size: file.size })); }' }));
      if (!checked.exceptionDetails) selected = object(checked.result).value;
    } catch { /* Some sites remove/reset the input or navigate immediately after change. Never repeat selection. */ }
    const fileSelectionVerified = Array.isArray(selected) && selected.length === files.length && selected.every((file, index) =>
      object(file).name === files[index].name && object(file).size === files[index].size);
    return { status: 'files_selected', files: files.map(({ name, size }) => ({ name, size })), fileSelectionVerified, outcomeVerified: false };
  } finally {
    if (objectId) await command('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}
