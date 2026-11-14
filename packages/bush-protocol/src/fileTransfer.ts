export const FILE_TRANSFER_LIMIT = 2 * 1024 * 1024 * 1024;
export const FILE_TRANSFER_CHUNK_SIZE = 512 * 1024;
export const MEDIA_FILE_EXTENSION = /\.(mp4|m4v|mov|webm|mp3|wav|ogg|m4a)$/i;
export function transferredFileMime(name: string, bytes: Uint8Array): string {
  const ext = name.split('.').at(-1)?.toLowerCase();
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (ext === 'png' && bytes[0] === 137 && ascii(1, 3) === 'PNG') return 'image/png';
  if (['jpg','jpeg'].includes(ext ?? '') && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (ext === 'webp' && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(4, 4) === 'ftyp') {
    if (ext === 'm4a') return 'audio/mp4';
    if (['mp4', 'm4v', 'mov'].includes(ext ?? '')) return ext === 'mov' ? 'video/quicktime' : 'video/mp4';
  }
  if (ext === 'webm' && bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) return 'video/webm';
  if (ext === 'wav' && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ext === 'ogg' && ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ext === 'mp3' && (ascii(0, 3) === 'ID3' || bytes[0] === 255 && (bytes[1]! & 224) === 224)) return 'audio/mpeg';
  if (ext === 'pdf' && ascii(0, 5) === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
}
