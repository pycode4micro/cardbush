import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { ZodError } from 'zod';
import { CALENDAR_FILE_BYTES } from '@cardbush/bush-protocol';
import { parseCalendarImport } from './calendarImport.mjs';

try {
  const file = await open(workerData.path, 'r');
  let text: string;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > CALENDAR_FILE_BYTES) throw Error('日历文件需小于 8 MiB。');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('日历文件仍在写入，请写完后重新导入。');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await file.close(); }
  parentPort!.postMessage({ calendar: parseCalendarImport(text, basename(workerData.path)) });
} catch (error) {
  const message = error instanceof ZodError
    ? error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'calendar'}: ${issue.message}`).join('\n') + (error.issues.length > 3 ? `\n另有 ${error.issues.length - 3} 处格式错误。` : '')
    : error instanceof Error ? error.message : String(error);
  parentPort!.postMessage({ error: message.slice(0, 1800) });
}
