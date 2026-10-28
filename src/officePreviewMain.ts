import { htmlText } from './i18n/htmlText';
import { uiText, resolveUiLanguage } from './i18n';
import {
  findFileViewerZoomProvider,
  type FileRenderContext,
  type FileViewerRenderedInstance,
  type FileViewerZoomProvider,
  type FileRenderExportAdapter,
} from '@file-viewer/core';
import pptFontUrl from '@file-viewer/ppt/ppt-font-cjk.otf?url';
import pptWasmUrl from '@file-viewer/ppt/ppt-native.wasm?url';
import pptWorkerUrl from '@file-viewer/ppt/worker.mjs?url';
import spreadsheetWorkerUrl from '@file-viewer/renderer-spreadsheet/worker/sheet.worker.js?url';
import pptxWorkerUrl from './office/pptx.worker.ts?worker&url';

import './styles/officePreview.css';

type OfficePreviewKind = 'spreadsheet' | 'presentation';

const parameters = new URLSearchParams(window.location.search);
const language = resolveUiLanguage(parameters.get('lang') ?? navigator.language);
document.documentElement.lang = language;
const filePath = parameters.get('path')?.trim() ?? '';
const fileName = filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? uiText(language)('officePreviewMain.office_file');
const extension = fileName.includes('.')
  ? `.${fileName.split('.').at(-1)?.toLowerCase()}`
  : '';
const previewKind: OfficePreviewKind | null = extension === '.xlsx'
  ? 'spreadsheet'
  : extension === '.pptx' || extension === '.ppt'
    ? 'presentation'
    : null;

const root = document.getElementById('office-preview-root');

if (root == null) {
  throw new Error('Office preview root is missing.');
}

document.title = uiText(language)('officePreviewMain.value1_read_only_preview', { value1: fileName });
document.documentElement.dataset.officePreviewKind = previewKind ?? 'unsupported';

root.innerHTML = `
  <div class="office-preview-shell">
    <div class="office-preview-toolbar" role="toolbar" aria-label="${htmlText(uiText(language)('officePreviewMain.office_read_only_preview_tools'))}">
      <span class="office-preview-app-mark" aria-hidden="true">${previewKind === 'spreadsheet' ? 'X' : 'P'}</span>
      <span class="office-preview-readonly">${htmlText(uiText(language)('messageBubble.readOnly'))}</span>
      <span class="office-preview-progress" role="status" aria-live="polite">${htmlText(uiText(language)('officePreviewMain.reading_file'))}</span>
      <span class="office-preview-toolbar-spacer"></span>
      <div class="office-preview-zoom" aria-label="${htmlText(uiText(language)('browserMenu.zoom'))}">
        <button type="button" data-office-action="zoom-out" aria-label="${htmlText(uiText(language)('image.zoomOutHint'))}" disabled>−</button>
        <button type="button" class="office-preview-zoom-value" data-office-action="zoom-reset" aria-label="${htmlText(uiText(language)('officePreviewMain.reset_zoom'))}" disabled>100%</button>
        <button type="button" data-office-action="zoom-in" aria-label="${htmlText(uiText(language)('image.zoomInHint'))}" disabled>＋</button>
      </div>
      <button type="button" data-office-action="fit" disabled>${htmlText(uiText(language)('image.resetHint'))}</button>
    </div>
    <main id="office-render-surface" class="office-preview-surface" aria-label="${htmlText(uiText(language)('officePreviewMain.read_only_office_content'))}"></main>
    <section class="office-preview-error" hidden aria-live="assertive">
      <strong>${htmlText(uiText(language)('officePreviewMain.could_not_load_the_full_preview'))}</strong>
      <p data-office-error-message></p>
      ${extension === '.pptx' ? '' : `<button type="button" data-office-action="compat">${htmlText(uiText(language)('officePreviewMain.use_compatibility_preview'))}</button>`}
    </section>
  </div>`;

const surfaceElement = document.getElementById('office-render-surface') as HTMLDivElement | null;
const progress = root.querySelector<HTMLElement>('.office-preview-progress');
const errorPanel = root.querySelector<HTMLElement>('.office-preview-error');
const errorMessage = root.querySelector<HTMLElement>('[data-office-error-message]');
const zoomControls = Array.from(
  root.querySelectorAll<HTMLButtonElement>('[data-office-action^="zoom"], [data-office-action="fit"]'),
);
const abortController = new AbortController();
let renderedInstance: FileViewerRenderedInstance | null = null;
let zoomProvider: FileViewerZoomProvider | null = null;
let unsubscribeZoom: (() => void) | null = null;
let previewReady = false;
let exportAdapter: FileRenderExportAdapter | null = null;

if (surfaceElement == null) {
  throw new Error('Office preview surface is missing.');
}
const surface: HTMLDivElement = surfaceElement;

function setProgress(message: string, hidden = false) {
  if (progress == null) return;
  progress.textContent = message;
  progress.hidden = hidden;
}

function updateZoomControls() {
  const state = zoomProvider?.getState();
  const label = state?.label ?? `${Math.round((state?.scale ?? 1) * 100)}%`;
  const value = root?.querySelector<HTMLButtonElement>('[data-office-action="zoom-reset"]');
  const zoomIn = root?.querySelector<HTMLButtonElement>('[data-office-action="zoom-in"]');
  const zoomOut = root?.querySelector<HTMLButtonElement>('[data-office-action="zoom-out"]');
  const fit = root?.querySelector<HTMLButtonElement>('[data-office-action="fit"]');
  if (value) value.textContent = label;
  if (zoomIn) zoomIn.disabled = zoomProvider == null || state?.canZoomIn === false;
  if (zoomOut) zoomOut.disabled = zoomProvider == null || state?.canZoomOut === false;
  if (value) value.disabled = zoomProvider == null;
  if (fit) fit.disabled = zoomProvider == null;
}

function connectZoomProvider() {
  unsubscribeZoom?.();
  zoomProvider = findFileViewerZoomProvider(surface);
  unsubscribeZoom = zoomProvider?.subscribe?.(updateZoomControls) ?? null;
  updateZoomControls();
}

async function fitPreview() {
  if (zoomProvider == null) return;
  if (zoomProvider.fit == null) {
    await zoomProvider.resetZoom();
    return;
  }
  const bounds = surface.getBoundingClientRect();
  await zoomProvider.fit({
    mode: 'contain',
    resize: 'always',
    padding: 12,
    minScale: 0.25,
    maxScale: 3,
    source: 'user',
    reason: 'api',
    viewportWidth: bounds.width,
    viewportHeight: bounds.height,
    container: surface,
  });
}

function compatibilityUrl() {
  const url = new URL('cardbush-file://office-preview/');
  url.searchParams.set('path', filePath);
  url.searchParams.set('renderer', 'compat');
  return url.toString();
}

function describeError(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error != null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['message', 'detail', 'hint', 'error']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // Fall through to the generic message for non-serializable diagnostics.
    }
  }
  const value = String(error ?? '').trim();
  return value && value !== '[object Object]' ? value : uiText(language)('officePreviewMain.could_not_parse_the_file_contents');
}

function showError(error: unknown) {
  const message = describeError(error);
  setProgress(uiText(language)('officePreviewMain.full_preview_unavailable'));
  if (errorMessage) errorMessage.textContent = message;
  if (errorPanel) errorPanel.hidden = false;
  zoomControls.forEach((control) => { control.disabled = true; });
}

async function waitForSpreadsheetReady() {
  const startedAt = performance.now();
  await new Promise<void>((resolve, reject) => {
    const inspect = () => {
      if (abortController.signal.aborted) {
        reject(abortController.signal.reason);
        return;
      }
      const spreadsheetError = surface.querySelector<HTMLElement>('.excel-wrapper .error:not(.hidden)');
      if (spreadsheetError) {
        reject(new Error(spreadsheetError.textContent?.trim() || uiText(language)('officePreviewMain.could_not_parse_the_excel_workbook')));
        return;
      }
      const loading = surface.querySelector<HTMLElement>('.excel-wrapper .loading');
      const sheetTabs = surface.querySelectorAll('.excel-wrapper .sheet-tab');
      if (sheetTabs.length > 0 && (loading == null || loading.classList.contains('hidden'))) {
        resolve();
        return;
      }
      if (performance.now() - startedAt >= 60_000) {
        reject(new Error(uiText(language)('officePreviewMain.the_workbook_took_too_long_to_load')));
        return;
      }
      window.setTimeout(inspect, 60);
    };
    inspect();
  });
}

async function renderOfficeFile() {
  if (!filePath || previewKind == null) {
    throw new Error(uiText(language)('officePreviewMain.full_visual_previews_are_supported_for_xlsx'));
  }
  const sourceUrl = new URL('cardbush-file://office-source/');
  sourceUrl.searchParams.set('path', filePath);
  const response = await fetch(sourceUrl, {
    cache: 'no-store',
    signal: abortController.signal,
  });
  if (!response.ok) {
    if (response.status === 413) throw new Error(await response.text());
    throw new Error(uiText(language)('officePreviewMain.could_not_read_the_local_file_value1', { value1: response.status }));
  }
  const buffer = await response.arrayBuffer();
  if (extension === '.xlsx') {
    // The spreadsheet decoder also accepts CSV/plain text. A mislabeled or
    // corrupt XLSX must not silently turn into a plausible-looking worksheet.
    const { default: JSZip } = await import('jszip');
    const archive = await JSZip.loadAsync(buffer).catch(() => {
      throw new Error(uiText(language)('officePreviewMain.the_xlsx_file_is_not_a_valid'));
    });
    if (!archive.file('[Content_Types].xml') || !archive.file('xl/workbook.xml')) {
      throw new Error(uiText(language)('officePreviewMain.the_xlsx_file_has_no_workbook_structure'));
    }
  }
  if (buffer.byteLength === 0) {
    throw new Error(uiText(language)('officePreviewMain.the_file_is_empty'));
  }

  setProgress(previewKind === 'spreadsheet' ? uiText(language)('officePreviewMain.restoring_workbook') : uiText(language)('officePreviewMain.restoring_slides'));
  const context: FileRenderContext = {
    registerExportAdapter: adapter => { exportAdapter = adapter; },
    filename: fileName,
    url: sourceUrl.toString(),
    signal: abortController.signal,
    options: {
      theme: 'light',
      locale: language,
      ui: { density: 'comfortable', surfaceBackground: '#eef1f4' },
      fit: { mode: 'contain', resize: 'until-interaction', padding: 12 },
      spreadsheet: {
        worker: true,
        workerUrl: spreadsheetWorkerUrl,
        resizableColumns: true,
        resizableRows: true,
      },
      presentation: {
        ...(extension === '.pptx' ? { workerUrl: pptxWorkerUrl, workerType: 'module' as const } : {}),
        pptWasmUrl,
        pptFontUrl,
        pptWorkerUrl,
        pptWorker: 'auto',
        pptVirtualize: true,
      },
    },
    onProgressiveRender: () => {
      if (!previewReady) setProgress(uiText(language)('officePreviewMain.loading_remaining_content'));
    },
  };

  if (previewKind === 'spreadsheet') {
    const { renderFileViewerSpreadsheet } = await import('@file-viewer/renderer-spreadsheet');
    renderedInstance = await renderFileViewerSpreadsheet(buffer, surface, 'xlsx', context);
    await waitForSpreadsheetReady();
  } else if (extension === '.pptx') {
    await import('./office/pptxCharts');
    const { default: renderPptx } = await import('@file-viewer/renderer-pptx');
    renderedInstance = await renderPptx(buffer, surface, 'pptx', context);
  } else {
    const { default: renderPpt } = await import('@file-viewer/renderer-ppt');
    renderedInstance = await renderPpt(buffer, surface, 'ppt', context);
  }

  previewReady = true;
  if (extension === '.pptx' && exportAdapter && parameters.get('export') === 'png') {
    const { presentationSnapshot } = await import('./office/presentationSnapshot');
    (window as unknown as { cardbushPresentationExport: ReturnType<typeof presentationSnapshot> }).cardbushPresentationExport =
      presentationSnapshot(exportAdapter);
  }
  connectZoomProvider();
  setProgress(previewKind === 'spreadsheet' ? uiText(language)('officePreviewMain.workbook_fully_loaded') : uiText(language)('officePreviewMain.slides_fully_loaded'), true);
}

root.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-office-action]');
  if (button == null || button.disabled) return;
  const action = button.dataset.officeAction;
  if (action === 'compat') {
    window.location.replace(compatibilityUrl());
    return;
  }
  if (zoomProvider == null) return;
  const operation = action === 'zoom-in'
    ? zoomProvider.zoomIn()
    : action === 'zoom-out'
      ? zoomProvider.zoomOut()
      : action === 'zoom-reset'
        ? zoomProvider.resetZoom()
        : action === 'fit'
          ? fitPreview()
          : null;
  if (operation) {
    void Promise.resolve(operation).then(updateZoomControls).catch(showError);
  }
});

document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || zoomProvider == null) return;
  if (!['+', '=', '-', '0'].includes(event.key)) return;
  event.preventDefault();
  const operation = event.key === '-'
    ? zoomProvider.zoomOut()
    : event.key === '0'
      ? zoomProvider.resetZoom()
      : zoomProvider.zoomIn();
  void Promise.resolve(operation).then(updateZoomControls).catch(showError);
});

window.addEventListener('beforeunload', () => {
  abortController.abort();
  unsubscribeZoom?.();
  if (renderedInstance == null) return;
  if ('unmount' in renderedInstance) void renderedInstance.unmount();
  else if ('$destroy' in renderedInstance) void renderedInstance.$destroy();
  else void renderedInstance.destroy();
});

void renderOfficeFile().catch((error) => {
  if (!abortController.signal.aborted) showError(error);
});
