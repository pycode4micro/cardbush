import { mkdir, readFile, rename, rm, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { calendarCommandSchema, calendarDatasetSchema, CALENDAR_FILE_BYTES, CALENDAR_ENTRY_LIMIT, type CalendarDataset, type CalendarState, type CalendarCommandResult } from '@cardbush/bush-protocol';

const stateSchema = z.object({ version: z.literal(1), chineseLunar: z.boolean(), datasets: z.array(z.object({ calendar: calendarDatasetSchema, enabled: z.boolean() }).strict()).max(30) }).strict();
export class CalendarStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async load() {
    try {
      if ((await stat(this.path)).size > CALENDAR_FILE_BYTES * 2) throw Error('日历数据过大，无法读取。');
      return stateSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 as const, datasets: [], chineseLunar: true };
      throw error;
    }
  }
  async command(input: unknown, chooseFile: () => Promise<string | undefined>): Promise<CalendarCommandResult> {
    const command = calendarCommandSchema.parse(input);
    if (command.action === 'list') { await this.queue; return { state: await this.load() }; }
    // The chooser and bounded parser run without holding the store's write queue.
    let imported: CalendarDataset | undefined;
    if (command.action === 'import') {
      const path = await chooseFile();
      if (!path) return { state: await this.load(), cancelled: true };
      imported = await importCalendarFile(path);
    }
    const operation = this.queue.then(async () => {
      const state = await this.load();
      if (imported) {
        const previous = state.datasets.find(item => item.calendar.id === imported!.id);
        state.datasets = [...state.datasets.filter(item => item.calendar.id !== imported!.id), { calendar: imported, enabled: previous?.enabled ?? true }];
      } else if (command.action === 'remove') state.datasets = state.datasets.filter(item => item.calendar.id !== command.id);
      else if (command.action === 'lunar') state.chineseLunar = command.enabled;
      else if (command.action === 'enabled') {
        const dataset = state.datasets.find(item => item.calendar.id === command.id);
        if (!dataset) throw Error('日历已移除，请刷新。');
        dataset.enabled = command.enabled;
      }
      if (state.datasets.reduce((count, item) => count + item.calendar.entries.length, 0) > CALENDAR_ENTRY_LIMIT) throw Error('已保存的日历条目总数不能超过 50,000，请先移除不再使用的数据。');
      stateSchema.parse(state);
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > CALENDAR_FILE_BYTES * 2) throw Error('日历数据超过大小限制，请减少说明文本。');
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

export function importCalendarFile(path: string): Promise<CalendarDataset> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL('./calendarImportWorker.mjs', import.meta.url), { workerData: { path }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
    const timer = setTimeout(() => { reject(Error('日历解析超时，请减少重复规则或转换为 JSON 日期明细。')); void worker.terminate(); }, 5000);
    worker.once('message', message => { settled = true; clearTimeout(timer); void worker.terminate(); try { if (message.error) reject(Error(message.error)); else resolve(calendarDatasetSchema.parse(message.calendar)); } catch (error) { reject(error); } });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', () => { clearTimeout(timer); if (!settled) reject(Error('日历解析未完成，未保存任何更改。')); });
  });
}
