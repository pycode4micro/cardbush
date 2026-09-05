import { open, type FileHandle } from 'node:fs/promises';

// A regular-file read can be short. Never expose the unread part of a buffer.
export async function readHandleBytes(
  handle: Pick<FileHandle, 'read'>,
  length: number,
  position = 0,
): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return bytes.subarray(0, offset);
}

export async function readFilePrefix(filePath: string, length: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    return await readHandleBytes(handle, length);
  } finally {
    await handle.close();
  }
}
