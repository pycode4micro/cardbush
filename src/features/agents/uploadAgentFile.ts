const chunkSize = 512 * 1024;
const maxSize = 64 * 1024 * 1024;

export async function uploadAgentFile<T extends { nextOffset: number }>(file: Blob, send: (chunk: { offset: number; content: string; complete: boolean }) => Promise<T>): Promise<T> {
  if (file.size > maxSize) throw new Error('附件不能超过 64 MiB / Maximum attachment size: 64 MiB');
  let offset = 0;
  do {
    const bytes = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
    let raw = '';
    for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const next = await send({ offset, content: btoa(raw), complete: offset + bytes.length === file.size });
    if (next.nextOffset !== offset + bytes.length) throw new Error('Invalid upload acknowledgement.');
    offset = next.nextOffset;
    if (offset === file.size) return next;
  } while (offset < file.size);
  throw new Error('Incomplete attachment upload.');
}
