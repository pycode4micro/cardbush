import { open } from 'node:fs/promises';
import path from 'node:path';

const MiB = 1024 ** 2;
export const officePreviewLimits = { compressedBytes: 32 * MiB, expandedBytes: 128 * MiB, entryBytes: 32 * MiB, entries: 10_000 };
const tooLarge = '文件较大，已暂停内置预览。可在外部打开，或让助手生成摘要、分表预览。';

/** Read only ZIP metadata before any Office decoder allocates/unpacks the file. */
export async function checkOfficePreviewAdmission(filePath: string): Promise<void> {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > officePreviewLimits.compressedBytes) throw new Error(tooLarge);
    if (!['.xlsx', '.docx', '.pptx'].includes(path.extname(filePath).toLowerCase())) return;
    const tail = Buffer.alloc(Math.min(stat.size, 65_557));
    const { bytesRead } = await file.read(tail, 0, tail.length, stat.size - tail.length);
    if (bytesRead !== tail.length) throw new Error('文件读取期间发生变化，请重新打开。');
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) { end = at; break; }
    }
    if (end < 0) throw new Error('Office 文件压缩结构不完整。');
    const entries = tail.readUInt16LE(end + 10), size = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || entries === 0xffff
      || size === 0xffffffff || offset === 0xffffffff || entries > officePreviewLimits.entries || size > 4 * MiB) throw new Error(tooLarge);
    if (offset + size > stat.size - tail.length + end) throw new Error('Office 文件目录越界。');
    const directory = Buffer.alloc(size);
    if ((await file.read(directory, 0, size, offset)).bytesRead !== size) throw new Error('Office 文件目录不完整。');
    let cursor = 0, expanded = 0;
    for (let index = 0; index < entries; index++) {
      if (cursor + 46 > size || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Office 文件目录无效。');
      const entrySize = directory.readUInt32LE(cursor + 24);
      expanded += entrySize;
      if (entrySize > officePreviewLimits.entryBytes || expanded > officePreviewLimits.expandedBytes) throw new Error(tooLarge);
      if (directory.readUInt16LE(cursor + 8) & 1) throw new Error('加密文档请在外部应用打开。');
      cursor += 46 + directory.readUInt16LE(cursor + 28) + directory.readUInt16LE(cursor + 30) + directory.readUInt16LE(cursor + 32);
      if (cursor > size) throw new Error('Office 文件目录不完整。');
    }
    if (cursor !== size) throw new Error('Office 文件目录与条目数量不一致。');
  } finally { await file.close(); }
}
