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
  const native = asRecord(payload.result ?? payload);
  // The runtime dispatcher has an explicit envelope; arbitrary nested objects are not searched.
  const result = asRecord(native.mcp).name && native.result ? asRecord(native.result) : native;
  const structured = asRecord(result.structuredContent);
  const artifacts: ChatToolArtifact[] = [];
  collectDeclaredArtifacts(result.artifacts, artifacts);
  collectDeclaredArtifacts(structured.artifacts, artifacts);
  collectMcpContent(legacyComputerUseContent(native, result, structured), artifacts);
  return dedupeArtifacts(artifacts);
}

// Older Computer Use results omitted the assistant-only audience on the same
// screenshot bytes. Normalize that explicit one-image contract on history reads;
// unrelated MCP images (including results with uncertain delivery) stay visible.
function legacyComputerUseContent(
  native: Record<string, unknown>,
  result: Record<string, unknown>,
  structured: Record<string, unknown>,
) {
  const content = result.content;
  if (asRecord(native.mcp).name !== 'mcp__cardbush_apps__computer_use' || !Array.isArray(content)) return content;
  const delivery = asRecord(structured.image_delivery);
  if (delivery.status !== 'attached' || delivery.count !== 1) return content;
  const images = content.filter(item => asRecord(item).type === 'image');
  const declared = Array.isArray(structured.artifacts) ? structured.artifacts.map(asRecord) : [];
  const imageArtifacts = declared.filter(item => item.type === 'image');
  if (images.length !== 1 || imageArtifacts.length !== 1) return content;
  const artifact = imageArtifacts[0];
  const metadata = asRecord(artifact.metadata);
  const output = asRecord(structured.output);
  const path = stringValue(artifact.path);
  if (asRecord(images[0]).annotations != null || metadata.source !== 'cardbush_apps' || metadata.model_input !== false ||
      !isRenderableSource(path) || !Array.isArray(structured.paths) || !structured.paths.includes(path) ||
      (output.path ?? asRecord(output.observation).path) !== path) return content;
  return content.filter(item => item !== images[0]);
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
    const audience = asRecord(block.annotations).audience;
    if (Array.isArray(audience) && !audience.includes('user')) return;
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
      : type === 'document' ? 'attachment' : 'inline',
    readOnly: typeof (record.read_only ?? record.readOnly) === 'boolean'
      ? Boolean(record.read_only ?? record.readOnly)
      : true,
  };
}

function artifactType(
  source: string,
  hint: string,
  mimeType: string,
): ChatToolArtifact['type'] {
  const mime = mimeType.toLowerCase();
  if (hint === 'image' || mime.startsWith('image/') || isImagePath(source)) return 'image';
  if (hint === 'video' || mime.startsWith('video/') || isVideoPath(source)) return 'video';
  if (hint === 'audio' || mime.startsWith('audio/') || isAudioPath(source)) return 'audio';
  return 'document';
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
