import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, posix } from 'node:path';
import { parseSshWorkspace, sshWorkspace } from '@cardbush/bush-protocol';
import type { ToolAdmissionContext } from './toolRegistry.js';
import type { RemoteWorkspaceBridge } from './workspaceTools.js';
import { authorizePath } from './workspaceAccessPolicy.js';
import { localContext } from './workspaceToolRouting.js';

export type MemoFileSnapshot = { path: string; name: string; size: number; mtimeMs: number; content?: Buffer };

/** Explicit SSH identities never become local paths, even on a Windows host. */
export async function readMemoFile(target: string, maxBytes = 0, remote?: RemoteWorkspaceBridge, signal?: AbortSignal): Promise<MemoFileSnapshot> {
  const ssh = parseSshWorkspace(target);
  if (ssh) {
    if (!remote) throw Error('SSH file access is unavailable on this host.');
    const file = await remote.request('execute', { uri: sshWorkspace(ssh.connectionId, posix.dirname(ssh.path)),
      owner: 'file-reference', name: 'file_snapshot', input: { path: target, maxBytes } }, signal);
    if (file.kind !== 'file') throw Error('File references must target a file.');
    return { path: file.path, name: file.name, size: file.size, mtimeMs: file.mtimeMs,
      ...(typeof file.contentBase64 === 'string' ? { content: Buffer.from(file.contentBase64, 'base64') } : {}) };
  }
  if (!isAbsolute(target)) throw Error('Use an absolute local file path or ssh://saved-connection-id/absolute/file.');
  signal?.throwIfAborted();
  const path = await realpath(target), handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw Error('File references must target a file.');
    let content: Buffer | undefined;
    if (maxBytes > 0 && before.size <= maxBytes) {
      content = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < content.length) {
        signal?.throwIfAborted();
        const read = await handle.read(content, offset, content.length - offset, offset);
        if (!read.bytesRead) throw Error('File changed while recording reference; retry after the edit finishes.');
        offset += read.bytesRead;
      }
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('File changed while recording reference; retry after the edit finishes.');
    return { path, name: basename(path), size: after.size, mtimeMs: after.mtimeMs, ...(content ? { content } : {}) };
  } finally { await handle.close(); }
}

export async function authorizeMemoFile(context: ToolAdmissionContext<{ path: string }>, remote?: RemoteWorkspaceBridge) {
  const target = parseSshWorkspace(context.input.path);
  if (!target) {
    if (!isAbsolute(context.input.path)) throw Error('Use an absolute local file path or ssh://saved-connection-id/absolute/file.');
    return authorizePath('read')(localContext(context));
  }
  if (!remote) throw Error('SSH file access is unavailable on this host.');
  const metadata = context.turn?.request.metadata;
  const root = metadata?.workspaceDir || metadata?.projectDir || metadata?.sessionWorkspaceDir;
  const trusted = typeof root === 'string' && parseSshWorkspace(root)?.connectionId === target.connectionId ? root : undefined;
  const resolved = await remote.request('authorize', { uri: trusted ?? sshWorkspace(target.connectionId, '/'), path: context.input.path }, context.signal);
  if (trusted && resolved.inside) return { kind: 'allow' as const };
  return { kind: 'ask' as const, request: {
    reason: `SSH read: ${resolved.path}`, actions: ['read'],
    targets: [{ kind: 'filesystem_path' as const, value: resolved.path }], capabilityIds: [`ssh.read:${resolved.path}`],
    scope: { mode: context.turn?.request.permissionMode === 'user_free' ? 'user_free' as const : 'task_free' as const, roots: trusted ? [resolved.root] : [] },
  } };
}
