import { createContext, type ReactNode } from 'react';
import type { ChatToolArtifact, ChatToolExecution } from '../../types';
import { isAbsoluteLocalPath, stripWrappingQuotes } from '../../shared/localPaths';
import { remapProjectPath, type ProjectPathAlias } from '../conversationScope';
import { LocalFileReferenceLink } from './LocalFileReferenceLink';

/** A render-only projection of this turn's explicit artifacts, never a second file registry. */
export const PresentedMediaContext = createContext<ReadonlyMap<string, ChatToolArtifact>>(new Map());
export const ToolMediaContext = createContext<ReadonlyMap<string, ChatToolArtifact[]>>(new Map());

export function localMediaPath(source: string): string {
  const value = stripWrappingQuotes(source);
  if (!/^(?:file|cardbush-file):\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname);
    if (url.protocol === 'cardbush-file:' && /^[a-z]$/i.test(url.hostname)) return `${url.hostname.toUpperCase()}:${path}`;
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

function sameArtifact(left: ChatToolArtifact, right: ChatToolArtifact) {
  if (left === right) return true;
  const keys = Object.keys(left) as Array<keyof ChatToolArtifact>;
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);
}

/** One mounted transcript owns one cache. Tool status/output changes do not
 * invalidate every media/Markdown consumer through a fresh Context value. */
export function createToolOutputProjector() {
  let inputs: Array<{ owner: string; artifact: ChatToolArtifact }> = [];
  let pathAliases: ProjectPathAlias[] = [];
  let previous = toolOutputPresentation([]);
  return (executions: ChatToolExecution[], aliases: ProjectPathAlias[] = []) => {
    const nextInputs = executions.flatMap(execution =>
      (execution.artifacts ?? []).map(artifact => ({ owner: execution.id, artifact })));
    if (nextInputs.length === inputs.length && nextInputs.every((input, index) =>
      input.owner === inputs[index].owner && sameArtifact(input.artifact, inputs[index].artifact)) &&
      aliases.length === pathAliases.length && aliases.every((alias, index) =>
        alias.from === pathAliases[index].from && alias.to === pathAliases[index].to)) return previous;

    const next = toolOutputPresentation(executions, aliases);
    const retained = new Map(previous.artifacts.map(artifact => [mediaPresentationKey(artifact.path), artifact]));
    const reuse = (artifact: ChatToolArtifact) => {
      const existing = retained.get(mediaPresentationKey(artifact.path));
      return existing && sameArtifact(existing, artifact) ? existing : artifact;
    };
    next.artifacts = next.artifacts.map(reuse);
    for (const [key, artifact] of next.inlineMedia) next.inlineMedia.set(key, reuse(artifact));
    for (const [owner, artifacts] of next.mediaByExecution) {
      const values = artifacts.map(reuse);
      const existing = previous.mediaByExecution.get(owner);
      next.mediaByExecution.set(owner, existing?.length === values.length &&
        values.every((artifact, index) => artifact === existing[index]) ? existing : values);
    }
    inputs = nextInputs;
    pathAliases = aliases;
    previous = next;
    return next;
  };
}

/** Preserve the authored reference and its location without mounting another media preview. */
export function PresentedMediaReference({ artifact, children }: { artifact: ChatToolArtifact; children?: ReactNode }) {
  const label = children || artifact.name;
  return isAbsoluteLocalPath(artifact.path)
    ? <LocalFileReferenceLink path={artifact.path} knownFileName={artifact.name}>{label}</LocalFileReferenceLink>
    : <a href={artifact.path} target="_blank" rel="noreferrer">{label}</a>;
}
