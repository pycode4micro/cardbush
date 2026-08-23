import type { ChatToolArtifact } from '../types';
import {
  basename,
  isAbsoluteLocalPath,
  isAudioPath,
  isImagePath,
  isVideoPath,
  stripWrappingQuotes,
} from '../shared/localPaths';

const artifactPathKeys = [
  'path',
  'file_path',
  'filePath',
  'image_path',
  'imagePath',
  'url',
  'uri',
] as const;

export function toolArtifactsFromPayload(
  payload: Record<string, unknown>,
): ChatToolArtifact[] {
  const metadata = asRecord(payload.metadata);
  const result = asRecord(payload.result);
  const metadataResult = asRecord(metadata.result);
  const artifacts: ChatToolArtifact[] = [];
  const structuredCandidates = [
    payload,
    payload.artifacts,
    payload.images,
    payload.image,
    result.artifacts,
    result.images,
    result.image,
    metadata,
    metadata.artifacts,
    metadata.images,
    metadata.image,
    metadataResult.artifacts,
    metadataResult.images,
    metadataResult.image,
    typeof payload.output === 'object' ? payload.output : undefined,
  ];
  for (const candidate of structuredCandidates) {
    collectStructuredArtifacts(candidate, artifacts, 0);
  }
  collectOutputArtifacts(payload.output, artifacts);
  return dedupeArtifacts(artifacts);
}

export function mergeToolArtifacts(
  current: ChatToolArtifact[] | undefined,
  incoming: ChatToolArtifact[] | undefined,
) {
  return dedupeArtifacts([...(current ?? []), ...(incoming ?? [])]);
}

function collectStructuredArtifacts(
  value: unknown,
  artifacts: ChatToolArtifact[],
  depth: number,
) {
  if (value == null || depth > 4) return;
  if (typeof value === 'string') {
    const artifact = artifactFromString(value);
    if (artifact) artifacts.push(artifact);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredArtifacts(item, artifacts, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const artifact = artifactFromRecord(record);
  if (artifact) artifacts.push(artifact);
  for (const key of [
    'artifacts',
    'images',
    'image',
    'image_url',
    'imageUrl',
    'files',
    'items',
    'result',
    'data',
  ]) {
    if (record[key] != null) {
      collectStructuredArtifacts(record[key], artifacts, depth + 1);
    }
  }
}

function collectOutputArtifacts(output: unknown, artifacts: ChatToolArtifact[]) {
  if (typeof output !== 'string') return;
  const trimmed = output.trim();
  if (!trimmed) return;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      collectStructuredArtifacts(JSON.parse(trimmed), artifacts, 0);
    } catch {
      // Fall through to the conservative standalone-line compatibility parser.
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = stripLegacyLinePrefix(line);
    const artifact = artifactFromString(candidate);
    if (artifact) artifacts.push(artifact);
  }
}

function artifactFromRecord(record: Record<string, unknown>): ChatToolArtifact | null {
  const pathValue = artifactPathKeys
    .map((key) => stringValue(record[key]))
    .find(Boolean);
  if (!pathValue) return null;
  const mimeType = stringValue(
    record.mime_type ?? record.mimeType ?? record.content_type ?? record.contentType,
  );
  const hint = stringValue(record.kind ?? record.type ?? record.media_type ?? record.mediaType)
    .toLowerCase();
  const type = artifactType(pathValue, hint, mimeType);
  if (!type) return null;
  const name = stringValue(record.name ?? record.filename) || basename(pathValue);
  const size = numberValue(record.size ?? record.byte_size ?? record.byteSize);
  const displayValue = stringValue(record.display).toLowerCase();
  const display = displayValue === 'attachment' ? 'attachment' : 'inline';
  const readOnlyValue = record.read_only ?? record.readOnly;
  return {
    id: stringValue(record.id ?? record.artifact_id ?? record.artifactId) ||
      `tool-artifact-${normalizeArtifactKey(pathValue)}`,
    name,
    type,
    path: pathValue,
    ...(size != null ? { size } : {}),
    ...(mimeType ? { mimeType } : {}),
    display,
    readOnly: typeof readOnlyValue === 'boolean' ? readOnlyValue : true,
  };
}

function artifactFromString(value: string): ChatToolArtifact | null {
  const pathValue = stripWrappingQuotes(value.trim());
  if (!isRenderableSource(pathValue)) return null;
  const type = artifactType(pathValue, '', '');
  if (!type) return null;
  return {
    id: `tool-artifact-${normalizeArtifactKey(pathValue)}`,
    name: basename(pathValue),
    type,
    path: pathValue,
    display: 'inline',
    readOnly: true,
  };
}

function artifactType(
  pathValue: string,
  hint: string,
  mimeType: string,
): ChatToolArtifact['type'] | null {
  const normalizedMime = mimeType.toLowerCase();
  if (
    hint === 'image' ||
    hint === 'image_url' ||
    normalizedMime.startsWith('image/') ||
    /^data:image\//i.test(pathValue) ||
    isImagePath(pathValue)
  ) {
    return 'image';
  }
  if (
    hint === 'video' ||
    normalizedMime.startsWith('video/') ||
    /^data:video\//i.test(pathValue) ||
    isVideoPath(pathValue)
  ) {
    return 'video';
  }
  if (
    hint === 'audio' ||
    normalizedMime.startsWith('audio/') ||
    /^data:audio\//i.test(pathValue) ||
    isAudioPath(pathValue)
  ) {
    return 'audio';
  }
  return null;
}

function isRenderableSource(value: string) {
  return Boolean(
    value &&
      (isAbsoluteLocalPath(value) ||
        /^file:\/\//i.test(value) ||
        /^https?:\/\//i.test(value) ||
        /^data:(?:image|video|audio)\//i.test(value)),
  );
}

function stripLegacyLinePrefix(value: string) {
  return stripWrappingQuotes(
    value
      .trim()
      .replace(/^(?:[-*+]\s+|(?:image|path|file|图片|路径)\s*[:=]\s*)/i, '')
      .replace(/[;,]$/, '')
      .trim(),
  );
}

function dedupeArtifacts(artifacts: ChatToolArtifact[]) {
  const byPath = new Map<string, ChatToolArtifact>();
  for (const artifact of artifacts) {
    const pathValue = artifact.path.trim();
    if (!pathValue) continue;
    const key = normalizeArtifactKey(pathValue);
    const current = byPath.get(key);
    byPath.set(key, current ? { ...current, ...artifact, id: current.id || artifact.id } : artifact);
  }
  return [...byPath.values()];
}

function normalizeArtifactKey(value: string) {
  return value.replaceAll('\\', '/').toLowerCase();
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
