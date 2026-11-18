import { uiText } from '../src/i18n';
import type { Attachment } from './AgentWidgets';
import { api, requestId } from './api';
import { prepareAttachment, uploadInChunks } from './attachmentUpload';

export async function layerCommand<T>(input: Record<string, unknown>, signal: AbortSignal) {
  return api<T & { isError?: boolean }>('/layers', 'POST', input, signal);
}

export async function uploadLayerImage(source: File, signal: AbortSignal, onProgress = (_message: string) => {}) {
  if (!(source instanceof File) || !/\.(png|jpe?g|webp)$/i.test(source.name)) throw new Error(uiText()('web.layersChooseImage'));
  const { file } = await prepareAttachment(source, signal, onProgress);
  const uploadId = requestId();
  return uploadInChunks<Attachment>(file, signal, chunk => api('/files', 'POST', {
    ...chunk, uploadId, name: file.name, size: file.size,
  }, signal), percent => onProgress(uiText()('web.uploading', { name: file.name, percent })));
}
