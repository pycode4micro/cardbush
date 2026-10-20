/** The upstream post-processor catches failures. Leave an observable result for
 * the live document and reject incomplete snapshots instead of exporting blanks. */
export async function renderPptxChart(chart: Record<string, unknown>, generate: (options: unknown) => { flush(): void; destroy(): void }, target: HTMLElement) {
  let handle: ReturnType<typeof generate> | undefined;
  try {
    handle = generate({ ...chart, transition: { duration: 0 }, render: { lazy: false } });
    // Export immediately clones the live SVG. Transitions/lazy rendering must
    // not race that clone, including slides mounted only for export.
    handle.flush();
    if (!target.querySelector('svg .bb-chart')) throw new Error('Chart SVG was not produced.');
    target.dataset.cardbushChartState = 'ready';
    return handle;
  } catch (error) {
    handle?.destroy();
    markPptxChartFailure(target, error);
    throw error;
  }
}

export function markPptxChartFailure(target: HTMLElement, error: unknown) {
  target.dataset.cardbushChartState = 'failed';
  target.replaceChildren();
  const message = target.ownerDocument.createElement('div');
  message.className = 'cardbush-chart-error';
  message.textContent = '图表预览失败，请在原应用中查看';
  message.title = error instanceof Error ? error.message : String(error);
  target.append(message);
}
