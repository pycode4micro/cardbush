import { MAX_MODEL_IMAGE_SOURCE_BYTES, ModelImageInputError, type ModelImageStore } from './modelImageStore.js';

/** MCP binary content is an observation, never text for the model to reproduce. */
const omittedImageData = '[Image bytes omitted from text. Use the attached tool image or saved image path.]';

export interface McpImageInput {
  data: string;
  mimeType: string;
  detail?: 'low' | 'high';
}

export type ToolImageReceipt = { toolCallId: string; index: number; path?: string; code?: string; message?: string };
export type ToolImageObservation = ({ image: { url: string; detail?: 'low' | 'high' } } |
  { error: { toolCallId: string; code: string; message: string } }) & { receipt?: ToolImageReceipt };

export async function snapshotMcpImages(result: unknown, toolCallId: string, store: ModelImageStore, signal?: AbortSignal): Promise<ToolImageObservation[]> {
  const observations: ToolImageObservation[] = [];
  const inputs = mcpImageInputs(result);
  const snapshots = new Map<string, Promise<string>>();
  const maximumBatchCharacters = Math.ceil(MAX_MODEL_IMAGE_SOURCE_BYTES / 3) * 4;
  let sourceChars = 0;
  for (const [index, item] of inputs.slice(0, 16).entries()) {
    const receipt: ToolImageReceipt = { toolCallId, index };
    try {
      sourceChars += item.data.length;
      if (sourceChars > maximumBatchCharacters) throw new ModelImageInputError('image_result_too_large', 'MCP image batch exceeds the source byte budget. Request fewer or smaller images.');
      const source = `data:${item.mimeType};base64,${item.data}`;
      let snapshot = snapshots.get(source);
      if (!snapshot) { snapshot = store.snapshot(source, signal); snapshots.set(source, snapshot); }
      const url = await snapshot;
      observations.push({ image: { url, ...(item.detail ? { detail: item.detail } : {}) }, receipt: { ...receipt, path: url } });
    } catch (error) {
      const failure = { toolCallId, code: error instanceof ModelImageInputError ? error.code : signal?.aborted ? 'image_input_cancelled' : 'image_input_unavailable',
        message: error instanceof Error ? error.message : 'MCP image could not be prepared. Request a complete image; do not reconstruct its bytes.' };
      observations.push({ error: failure, receipt: { ...receipt, code: failure.code, message: failure.message } });
    }
  }
  if (inputs.length > 16) observations.push({
    error: { toolCallId, code: 'image_result_limit', message: `${inputs.length - 16} additional images were not prepared. Request a smaller image batch.` },
    receipt: { toolCallId, index: 16, code: 'image_result_limit' },
  });
  return observations;
}

export function mcpImageInputs(result: unknown): McpImageInput[] {
  const value = object(result);
  if (!value) return [];
  if (object(value.mcp) && object(value.result)) return mcpImageInputs(value.result);
  if (!Array.isArray(value.content)) return [];
  return value.content.flatMap(block => {
    const item = object(block);
    if (!item) return [];
    const resource = item.type === 'resource' ? object(item.resource) : undefined;
    const data = item.type === 'image' ? item.data : resource?.blob;
    const mimeType = item.type === 'image' ? item.mimeType : resource?.mimeType;
    if (typeof data !== 'string' || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) return [];
    const audience = object(item.annotations)?.audience;
    if (Array.isArray(audience) && !audience.includes('assistant')) return [];
    const detail = object(item._meta)?.['codex/imageDetail'];
    return [{ data, mimeType, ...(detail === 'low' || detail === 'high' ? { detail } : {}) }];
  });
}

/** Copy only changed branches; keep the original execution/journal result intact. */
export function omitToolImageData(input: unknown): unknown {
  if (typeof input === 'string' && /^data:image\//i.test(input)) return omittedImageData;
  if (Array.isArray(input)) {
    const output = input.map(omitToolImageData);
    return output.some((item, index) => item !== input[index]) ? output : input;
  }
  const value = object(input);
  if (!value) return input;
  const image = value.type === 'image' || (typeof value.mimeType === 'string' && value.mimeType.startsWith('image/'));
  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    const binary = image && typeof item === 'string' && (key === 'data' || key === 'blob');
    const next = binary ? omittedImageData : omitToolImageData(item);
    changed ||= next !== item;
    return [key, next];
  });
  return changed ? Object.fromEntries(entries) : input;
}

/** Also sanitize pre-upgrade archived modelText, without interpreting plain text. */
export function omitToolImageDataFromText(text: string): string {
  if (!text.includes('"image') && !text.includes('data:image/')) return text;
  try {
    const value = JSON.parse(text);
    const projected = omitToolImageData(value);
    return projected === value ? text : JSON.stringify(projected);
  } catch { return text; }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
