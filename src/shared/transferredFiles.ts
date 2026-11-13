import { uiText } from '../i18n';

export function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error(uiText()('composer.failed_to_read_image')));
    reader.readAsDataURL(file);
  });
}

function pathForTransferredFile(file: File): string {
  try { return window.cardbushDesktop?.getPathForFile?.(file)?.trim() ?? ''; }
  catch { return ''; }
}

type TransferredAttachment = { path: string; name: string; previewUrl?: string };

async function importTransferredFile(file: File): Promise<TransferredAttachment> {
  const local = pathForTransferredFile(file);
  if (local) return { path: local, name: file.name };
  const desktop = window.cardbushDesktop;
  if (!desktop) throw Error('desktop_unavailable');
  if (file.size > 64 * 1024 * 1024) throw Error(uiText()('uploadAgentFile.maximum_attachment_size_64_mib'));
  if (/^image\/(?:png|jpe?g|gif|bmp|webp)$/i.test(file.type)) {
    const previewUrl = await readFileAsDataUrl(file);
    const saved = await desktop.saveImageDataUrl(previewUrl, file.name);
    return { path: saved.path, name: file.name || saved.name, previewUrl };
  }
  const path = await desktop.saveTransferredFile(file.name, new Uint8Array(await file.arrayBuffer()));
  return { path, name: file.name };
}

export async function importTransferredFiles(files: File[]) {
  const attachments: TransferredAttachment[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try { attachments.push(await importTransferredFile(file)); }
    catch (error) { errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { attachments, errors };
}
