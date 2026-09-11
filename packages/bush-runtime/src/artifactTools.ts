import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import type { ToolRegistry } from './toolRegistry.js';
import { authorizePath } from './workspaceTools.js';

const media: Record<string, [string, string]> = {
  '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'],
  '.webp': ['image', 'image/webp'], '.gif': ['image', 'image/gif'], '.svg': ['image', 'image/svg+xml'],
  '.mp4': ['video', 'video/mp4'], '.webm': ['video', 'video/webm'], '.mov': ['video', 'video/quicktime'],
  '.mp3': ['audio', 'audio/mpeg'], '.wav': ['audio', 'audio/wav'], '.ogg': ['audio', 'audio/ogg'],
  '.m4a': ['audio', 'audio/mp4'], '.flac': ['audio', 'audio/flac'], '.pdf': ['document', 'application/pdf'],
};

/** Explicit publication to the conversation. No filename/prose scanning or task acceptance. */
export function registerArtifactTools(registry: ToolRegistry): void {
  registry.register<{ path: string }>({
    definition: {
      name: 'present_artifact',
      description: 'Present an existing local file in the conversation output area, including files created with terminal tools. Pass its absolute path explicitly. Returns file metadata and an artifact attachment for the UI.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 32768 } } },
    },
    manifest: { effect_kind: 'observation', operation: 'artifact.present', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false },
    parallelSafe: true,
    decodeInput: value => {
      const input = value as Record<string, unknown>;
      if (!input || typeof input.path !== 'string' || !isAbsolute(input.path) || input.path.length > 32768 || Object.keys(input).some(key => key !== 'path')) throw new Error('Use one existing absolute file path.');
      return { path: input.path };
    },
    authorize: authorizePath('read'),
    execute: async context => {
      context.signal?.throwIfAborted();
      const path = await realpath(context.input.path), file = await stat(path);
      if (!file.isFile()) throw new Error('An artifact must be a file.');
      context.signal?.throwIfAborted();
      const [type, mimeType] = media[extname(path).toLowerCase()] ?? ['document', 'application/octet-stream'];
      const identity = process.platform === 'win32' ? path.toLowerCase() : path;
      const id = 'artifact_' + createHash('sha256').update(JSON.stringify([context.sessionId, identity, file.size, file.mtimeMs])).digest('hex').slice(0, 32);
      return { protocol: 'bush.artifact.v1', presentation: 'submitted',
        file: { path, size: file.size, mtimeMs: file.mtimeMs, mediaTypeSource: 'extension' },
        artifacts: [{ id, path, name: basename(path), type, mimeType, size: file.size, display: type === 'document' ? 'attachment' : 'inline', readOnly: true }],
      };
    },
  });
}
