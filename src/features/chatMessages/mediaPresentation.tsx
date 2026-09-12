import { createContext, type ReactNode } from 'react';
import type { ChatToolArtifact, ChatToolExecution } from '../../types';
import { isAbsoluteLocalPath, stripWrappingQuotes } from '../../shared/localPaths';
import { remapProjectPath, type ProjectPathAlias } from '../conversationScope';
import { LocalFileReferenceLink } from './LocalFileReferenceLink';

/** A render-only projection of this turn's explicit artifacts, never a second file registry. */
export const PresentedMediaContext = createContext<ReadonlyMap<string, ChatToolArtifact>>(new Map());
export const ToolMediaContext = createContext<ReadonlyMap<string, ChatToolArtifact[]>>(new Map());

function localMediaPath(source: string): string {
  const value = stripWrappingQuotes(source);
  if (!/^(?:file|cardbush-file):\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname);
    return url.hostname && url.hostname !== 'localhost'
      ? `//${url.hostname}${path}` : path.replace(/^\/(?=[a-z]:[\\/])/i, '');
  } catch { return value; }
}

/** Local spelling aliases share an identity; remote query strings and case remain significant. */
export function mediaPresentationKey(source: string): string {
  const value = localMediaPath(source);
  if (!isAbsoluteLocalPath(value)) return value;
  const slashes = value.replaceAll('\\', '/');
  const unc = slashes.startsWith('//');
  const normalized = `${unc ? '/' : ''}${slashes.replace(/\/+/g, '/')}`;
  return `local:${unc || /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized}`;
}

export function toolOutputPresentation(executions: ChatToolExecution[], aliases: ProjectPathAlias[] = []) {
  const byPath = new Map<string, ChatToolArtifact>();
  const sourceKeys = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const execution of executions) for (const artifact of execution.artifacts ?? []) {
    const path = remapProjectPath(localMediaPath(artifact.path), aliases);
    const key = mediaPresentationKey(path);
    byPath.set(key, path === artifact.path ? artifact : { ...artifact, path });
    sourceKeys.set(mediaPresentationKey(artifact.path), key);
    // Later observations can enrich a result without moving its first appearance.
    if (!owners.has(key)) owners.set(key, execution.id);
  }
  const inlineMedia = new Map<string, ChatToolArtifact>();
  for (const [source, key] of sourceKeys) {
    const artifact = byPath.get(key)!;
    if (artifact.display !== 'attachment' && ['image', 'video', 'audio'].includes(artifact.type)) {
      inlineMedia.set(source, artifact);
      inlineMedia.set(key, artifact);
    }
  }
  const mediaByExecution = new Map<string, ChatToolArtifact[]>();
  for (const [key, artifact] of byPath) {
    if (!['image', 'video', 'audio'].includes(artifact.type)) continue;
    const owner = owners.get(key)!;
    mediaByExecution.set(owner, [...(mediaByExecution.get(owner) ?? []), artifact]);
  }
  return { artifacts: [...byPath.values()], inlineMedia, mediaByExecution };
}

/** Preserve the authored reference and its location without mounting another media preview. */
export function PresentedMediaReference({ artifact, children }: { artifact: ChatToolArtifact; children?: ReactNode }) {
  const label = children || artifact.name;
  return isAbsoluteLocalPath(artifact.path)
    ? <LocalFileReferenceLink path={artifact.path} knownFileName={artifact.name}>{label}</LocalFileReferenceLink>
    : <a href={artifact.path} target="_blank" rel="noreferrer">{label}</a>;
}
