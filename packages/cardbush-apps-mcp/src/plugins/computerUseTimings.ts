import { AsyncLocalStorage } from 'node:async_hooks';

export type ComputerUseTimings = {
  total_ms: number;
  process_count: number;
  process_start_ms: number;
  initialization_ms: number;
  compile_ms: number;
  input_ms: number;
  screenshot_ms: number;
  uia_ms: number;
  settle_ms: number;
};

const storage = new AsyncLocalStorage<ComputerUseTimings>();
export function collectComputerUseTimings<T>(run: () => Promise<T>): Promise<{ value: T; timings: ComputerUseTimings }> {
  const timings: ComputerUseTimings = { total_ms: 0, process_count: 0, process_start_ms: 0,
    initialization_ms: 0, compile_ms: 0, input_ms: 0, screenshot_ms: 0, uia_ms: 0, settle_ms: 0 };
  return storage.run(timings, async () => {
    const started = performance.now();
    try { return { value: await run(), timings }; }
    catch (error) {
      if (error && typeof error === 'object') Object.assign(error, { computerUseTimings: timings });
      throw error;
    } finally { timings.total_ms = Math.round(performance.now() - started); }
  });
}

export function addComputerUseTimings(values: Partial<ComputerUseTimings>): void {
  const target = storage.getStore();
  if (!target) return;
  for (const [key, value] of Object.entries(values)) {
    if (key in target && key !== 'total_ms' && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      target[key as keyof ComputerUseTimings] += Math.round(value);
    }
  }
}

export function failedComputerUseTimings(error: unknown): ComputerUseTimings | undefined {
  return error && typeof error === 'object' && 'computerUseTimings' in error
    ? error.computerUseTimings as ComputerUseTimings : undefined;
}
