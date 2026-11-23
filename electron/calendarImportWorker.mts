import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { ZodError } from 'zod';
import { CALENDAR_FILE_BYTES } from '@cardbush/bush-protocol';
import { parseCalendarImport } from './calendarImport.mjs';
import { CalendarError } from './calendarError.mjs';

try {
  const file = await open(workerData.path, 'r').catch(() => {
    throw new CalendarError('calendarError.unreadableFile');
  });
  let text: string;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > CALENDAR_FILE_BYTES) throw new CalendarError('calendarError.fileTooLarge');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new CalendarError('calendarError.fileChanged');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await file.close(); }
  parentPort!.postMessage({ calendar: parseCalendarImport(text, basename(workerData.path), undefined, workerData.language) });
} catch (error) {
  const failure = error instanceof CalendarError ? error.failure
    : error instanceof ZodError
      ? { key: 'calendarError.invalidFields', variables: { fields: error.issues.slice(0, 3).map(issue => issue.path.join('.') || 'calendar').join(', ') } }
      : { key: 'calendarError.invalidData' };
  parentPort!.postMessage({ failure });
}
