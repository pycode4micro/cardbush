import type { ChatToolArtifact } from '../types';
import {
  basename,
  isAbsoluteLocalPath,
  isAudioPath,
  isImagePath,
  isVideoPath,
} from '../shared/localPaths';

// Product rendering understands only explicit native artifact channels. It does
// not infer files from arbitrary tool prose or recursively classify tool data.
export function toolArtifactsFromPayload(
  payload: Record<string, unknown>,
): ChatToolArtifact[] {
  const result = asRecord(payload.result ?? payload);
  const structured = asRecord(result.structuredContent);
  const artifacts: ChatToolArtifact[] = [];
  collectDeclaredArtifacts(result.artifacts, artifacts);
  collectDeclaredArtifacts(structured.artifacts, artifacts);
  collectMcpContent(result.content, artifacts);
  return dedupeArtifacts(artifacts);
}

export function mergeToolArtifacts(
  current: ChatToolArtifact[] | undefined,
  incoming: ChatToolArtifact[] | undefined,
) {
  return dedupeArtifacts([...(current ?? []), ...(incoming ?? [])]);
}

function collectDeclaredArtifacts(value: unknown, artifacts: ChatToolArtifact[]) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  for (const candidate of values) {
    if (typeof candidate === 'string') {
      const artifact = artifactFromSource(candidate, {});
      if (artifact) artifacts.push(artifact);
      continue;
    }
    const record = asRecord(candidate);
    const source = stringValue(
      record.path ?? record.url ?? record.uri ?? record.image_url ?? record.imageUrl,
    );
    const artifact = artifactFromSource(source, record);
    if (artifact) artifacts.push(artifact);
  }
}

function collectMcpContent(value: unknown, artifacts: ChatToolArtifact[]) {
  if (!Array.isArray(value)) return;
  value.forEach((candidate, index) => {
    const block = asRecord(candidate);
    const type = stringValue(block.type).toLowerCase();
    const mimeType = stringValue(block.mimeType ?? block.mime_type);
    const data = stringValue(block.data);
    if ((type === 'image' || type === 'audio') && data && mimeType) {
      artifacts.push({
        id: `mcp-content-${index}-${hashKey(data)}`,
        name: `${type}-${index + 1}`,
        type,
        path: `data:${mimeType};base64,${data}`,
        mimeType,
        display: 'inline',
        readOnly: true,
      });
      return;
    }
    if (type === 'resource' || type === 'resource_link') {
      const resource = type === 'resource' ? asRecord(block.resource) : block;
      const source = stringValue(resource.uri);
      const artifact = artifactFromSource(source, resource);
      if (artifact) artifacts.push(artifact);
    }
  });
}

function artifactFromSource(
  source: string,
  record: Record<string, unknown>,
): ChatToolArtifact | null {
  if (!isRenderableSource(source)) return null;
  const mimeType = stringValue(record.mime_type ?? record.mimeType);
  const hint = stringValue(record.kind ?? record.type ?? record.media_type ?? record.mediaType)
    .toLowerCase();
  const type = artifactType(source, hint, mimeType);
  if (!type) return null;
  const size = numberValue(record.size ?? record.byte_size ?? record.byteSize);
  return {
    id: stringValue(record.id ?? record.artifact_id ?? record.artifactId) ||
      `tool-artifact-${hashKey(source)}`,
    name: stringValue(record.name ?? record.filename) || basename(source),
    type,
    path: source,
    ...(size != null ? { size } : {}),
    ...(mimeType ? { mimeType } : {}),
    display: stringValue(record.display).toLowerCase() === 'attachment'
      ? 'attachment'
      : 'inline',
    readOnly: typeof (record.read_only ?? record.readOnly) === 'boolean'
      ? Boolean(record.read_only ?? record.readOnly)
      : true,
  };
}

function artifactType(
  source: string,
  hint: string,
  mimeType: string,
): ChatToolArtifact['type'] | null {
  const mime = mimeType.toLowerCase();
  if (hint === 'image' || mime.startsWith('image/') || isImagePath(source)) return 'image';
  if (hint === 'video' || mime.startsWith('video/') || isVideoPath(source)) return 'video';
  if (hint === 'audio' || mime.startsWith('audio/') || isAudioPath(source)) return 'audio';
  return null;
}

function isRenderableSource(value: string) {
  return Boolean(value && (
    isAbsoluteLocalPath(value) ||
    /^file:\/\//i.test(value) ||
    /^https?:\/\//i.test(value) ||
    /^data:(?:image|video|audio)\//i.test(value)
  ));
}

function dedupeArtifacts(artifacts: ChatToolArtifact[]) {
  const bySource = new Map<string, ChatToolArtifact>();
  for (const artifact of artifacts) {
    const key = artifact.path.trim().replaceAll('\\', '/').toLowerCase();
    if (!key) continue;
    const current = bySource.get(key);
    bySource.set(key, current ? { ...current, ...artifact, id: current.id } : artifact);
  }
  return [...bySource.values()];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function hashKey(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
