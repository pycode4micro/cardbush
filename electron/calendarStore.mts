import { mkdir, readFile, rename, rm, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { calendarCommandSchema, calendarDatasetSchema, CALENDAR_FILE_BYTES, CALENDAR_ENTRY_LIMIT, type CalendarDataset, type CalendarState, type CalendarCommandResult } from '@cardbush/bush-protocol';
import { CHINESE_CALENDAR_ID, isBuiltinCalendar, withBundledCalendars } from './calendarBuiltins.mjs';
import { CalendarError, type CalendarFailure } from './calendarError.mjs';

const stateSchema = z.object({ version: z.literal(1), chineseLunar: z.boolean(), datasets: z.array(z.object({ calendar: calendarDatasetSchema, enabled: z.boolean(), builtin: z.boolean().optional() }).strict()).max(32) }).strict();
export class CalendarStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async load() {
    try {
      if ((await stat(this.path)).size > CALENDAR_FILE_BYTES * 2) throw new CalendarError('calendarError.storeTooLarge');
      const stored = stateSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      return { version: 1 as const, ...await withBundledCalendars(stored) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 as const, ...await withBundledCalendars({ datasets: [], chineseLunar: false }) };
      if (error instanceof z.ZodError || error instanceof SyntaxError) throw new CalendarError('calendarError.invalidStore');
      throw error;
    }
  }
  async command(input: unknown, chooseFile: () => Promise<string | undefined>, language = 'en'): Promise<CalendarCommandResult> {
    const parsed = calendarCommandSchema.safeParse(input);
    if (!parsed.success) throw new CalendarError('calendarError.invalidCommand');
    const command = parsed.data;
    if (command.action === 'list') { await this.queue; return { state: await this.load() }; }
    // The chooser and bounded parser run without holding the store's write queue.
    let imported: CalendarDataset | undefined;
    if (command.action === 'import') {
      const path = await chooseFile();
      if (!path) return { state: await this.load(), cancelled: true };
      imported = await importCalendarFile(path, language);
      if (isBuiltinCalendar(imported.id)) throw new CalendarError('calendarError.builtinOverwrite');
    }
    const operation = this.queue.then(async () => {
      const state = await this.load();
      if (imported) {
        const previous = state.datasets.find(item => item.calendar.id === imported!.id);
        state.datasets = [...state.datasets.filter(item => item.calendar.id !== imported!.id), { calendar: imported, enabled: previous?.enabled ?? true }];
      } else if (command.action === 'remove') {
        if (isBuiltinCalendar(command.id)) throw new CalendarError('calendarError.builtinRemove');
        state.datasets = state.datasets.filter(item => item.calendar.id !== command.id);
      } else if (command.action === 'lunar') state.datasets.find(item => item.calendar.id === CHINESE_CALENDAR_ID)!.enabled = command.enabled;
      else if (command.action === 'enabled') {
        const dataset = state.datasets.find(item => item.calendar.id === command.id);
        if (!dataset) throw new CalendarError('calendarError.missingCalendar');
        dataset.enabled = command.enabled;
      }
      state.chineseLunar = state.datasets.find(item => item.calendar.id === CHINESE_CALENDAR_ID)!.enabled;
      if (state.datasets.filter(item => !item.builtin).reduce((count, item) => count + item.calendar.entries.length, 0) > CALENDAR_ENTRY_LIMIT) throw new CalendarError('calendarError.storeEntryLimit');
      stateSchema.parse(state);
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > CALENDAR_FILE_BYTES * 2) throw new CalendarError('calendarError.storeSizeLimit');
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, serialized, { mode: 0o600 }); await rename(temporary, this.path); }
      finally { await rm(temporary, { force: true }); }
      return { state: state as CalendarState, ...(imported ? { imported: imported.name } : {}) };
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}

export function importCalendarFile(path: string, language = 'en'): Promise<CalendarDataset> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL('./calendarImportWorker.mjs', import.meta.url), { workerData: { path, language }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      complete();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new CalendarError('calendarError.timeout'))), 5000);
    worker.once('message', (message: { failure?: CalendarFailure; calendar?: unknown }) => finish(() => {
      if (message.failure) return reject(new CalendarError(message.failure.key, message.failure.variables));
      const result = calendarDatasetSchema.safeParse(message.calendar);
      if (result.success) resolve(result.data);
      else reject(new CalendarError('calendarError.invalidData'));
    }));
    worker.once('error', () => finish(() => reject(new CalendarError('calendarError.workerStopped'))));
    worker.once('exit', () => finish(() => reject(new CalendarError('calendarError.workerStopped'))));
  });
}
