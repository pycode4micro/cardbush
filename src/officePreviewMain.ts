import {
  findFileViewerZoomProvider,
  type FileRenderContext,
  type FileViewerRenderedInstance,
  type FileViewerZoomProvider,
} from '@file-viewer/core';
import pptFontUrl from '@file-viewer/ppt/ppt-font-cjk.otf?url';
import pptWasmUrl from '@file-viewer/ppt/ppt-native.wasm?url';
import pptWorkerUrl from '@file-viewer/ppt/worker.mjs?url';
import spreadsheetWorkerUrl from '@file-viewer/renderer-spreadsheet/worker/sheet.worker.js?url';

import './styles/officePreview.css';

type OfficePreviewKind = 'spreadsheet' | 'presentation';

const parameters = new URLSearchParams(window.location.search);
const filePath = parameters.get('path')?.trim() ?? '';
const fileName = filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Office 文件';
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

document.title = `${fileName} · 只读预览`;
document.documentElement.dataset.officePreviewKind = previewKind ?? 'unsupported';

root.innerHTML = `
  <div class="office-preview-shell">
    <div class="office-preview-toolbar" role="toolbar" aria-label="Office 只读预览工具">
      <span class="office-preview-app-mark" aria-hidden="true">${previewKind === 'spreadsheet' ? 'X' : 'P'}</span>
      <span class="office-preview-readonly">只读</span>
      <span class="office-preview-progress" role="status" aria-live="polite">正在读取文件…</span>
      <span class="office-preview-toolbar-spacer"></span>
      <div class="office-preview-zoom" aria-label="缩放">
        <button type="button" data-office-action="zoom-out" aria-label="缩小" disabled>−</button>
        <button type="button" class="office-preview-zoom-value" data-office-action="zoom-reset" aria-label="重置缩放" disabled>100%</button>
        <button type="button" data-office-action="zoom-in" aria-label="放大" disabled>＋</button>
      </div>
      <button type="button" data-office-action="fit" disabled>适应窗口</button>
    </div>
    <main id="office-render-surface" class="office-preview-surface" aria-label="Office 只读内容"></main>
    <section class="office-preview-error" hidden aria-live="assertive">
      <strong>完整预览加载失败</strong>
      <p data-office-error-message></p>
      <button type="button" data-office-action="compat">使用兼容预览</button>
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
  return value && value !== '[object Object]' ? value : '文件内容无法解析。';
}

function showError(error: unknown) {
  const message = describeError(error);
  setProgress('完整预览不可用');
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
        reject(new Error(spreadsheetError.textContent?.trim() || 'Excel 工作簿解析失败。'));
        return;
      }
      const loading = surface.querySelector<HTMLElement>('.excel-wrapper .loading');
      const sheetTabs = surface.querySelectorAll('.excel-wrapper .sheet-tab');
      if (sheetTabs.length > 0 && (loading == null || loading.classList.contains('hidden'))) {
        resolve();
        return;
      }
      if (performance.now() - startedAt >= 60_000) {
        reject(new Error('工作簿加载超时，可改用兼容预览。'));
        return;
      }
      window.setTimeout(inspect, 60);
    };
    inspect();
  });
}

async function renderOfficeFile() {
  if (!filePath || previewKind == null) {
    throw new Error('仅 .xlsx、.pptx 和 .ppt 文件支持完整视觉预览。');
  }
  const sourceUrl = new URL('cardbush-file://office-source/');
  sourceUrl.searchParams.set('path', filePath);
  const response = await fetch(sourceUrl, {
    cache: 'no-store',
    signal: abortController.signal,
  });
  if (!response.ok) {
    throw new Error(`无法读取本地文件（${response.status}）。`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error('文件为空。');
  }

  setProgress(previewKind === 'spreadsheet' ? '正在还原工作簿…' : '正在还原幻灯片…');
  const context: FileRenderContext = {
    filename: fileName,
    url: sourceUrl.toString(),
    signal: abortController.signal,
    options: {
      theme: 'light',
      locale: 'zh-CN',
      ui: { density: 'comfortable', surfaceBackground: '#eef1f4' },
      fit: { mode: 'contain', resize: 'until-interaction', padding: 12 },
      spreadsheet: {
        worker: true,
        workerUrl: spreadsheetWorkerUrl,
        resizableColumns: true,
        resizableRows: true,
      },
      presentation: {
        pptWasmUrl,
        pptFontUrl,
        pptWorkerUrl,
        pptWorker: 'auto',
        pptVirtualize: true,
      },
    },
    onProgressiveRender: () => {
      if (!previewReady) setProgress('正在完成剩余内容…');
    },
  };

  if (previewKind === 'spreadsheet') {
    const { renderFileViewerSpreadsheet } = await import('@file-viewer/renderer-spreadsheet');
    renderedInstance = await renderFileViewerSpreadsheet(buffer, surface, 'xlsx', context);
    await waitForSpreadsheetReady();
  } else if (extension === '.pptx') {
    const { default: renderPptx } = await import('@file-viewer/renderer-pptx');
    renderedInstance = await renderPptx(buffer, surface, 'pptx', context);
  } else {
    const { default: renderPpt } = await import('@file-viewer/renderer-ppt');
    renderedInstance = await renderPpt(buffer, surface, 'ppt', context);
  }

  previewReady = true;
  connectZoomProvider();
  setProgress(previewKind === 'spreadsheet' ? '工作簿已完整加载' : '幻灯片已完整加载', true);
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
