import React from 'react';
import ReactDOM from 'react-dom/client';

import './styles/theme.css';
import './styles/app.css';
import './styles/windowMaterial.css';
import './styles/appearance.css';
import { installWindowVisibility } from './shared/windowVisibility';
import { DeferredModuleNotice, recoverableLazy } from './shared/recoverableLazy';

const stopWindowVisibility = installWindowVisibility();
const disposeWindowVisibility = () => {
  stopWindowVisibility();
  window.removeEventListener('pagehide', disposeWindowVisibility);
};
window.addEventListener('pagehide', disposeWindowVisibility, { once: true });
if (import.meta.hot) import.meta.hot.dispose(disposeWindowVisibility);

function rendererFailureMessage(value: unknown) {
  return value instanceof Error ? `${value.name}: ${value.message}` : String(value);
}

function reportRendererFailure(stage: string, payload: Record<string, unknown>) {
  void window.cardbushDesktop?.writeDebugLog('renderer-lifecycle', {
    stage,
    ...payload,
  }).catch(() => undefined);
}

window.addEventListener('error', (event) => {
  reportRendererFailure('window-error', {
    message: event.message,
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
    error: rendererFailureMessage(event.error),
  });
});

window.addEventListener('unhandledrejection', (event) => {
  reportRendererFailure('unhandled-rejection', {
    error: rendererFailureMessage(event.reason),
  });
});

const rendererWindow = new URLSearchParams(window.location.search).get('window');
const language = navigator.language.startsWith('zh') ? 'zh' : 'en';
// Select the window before importing its state owners. Companion and shadow
// windows must not initialize or download the main workspace just to render.
const RootWindow = recoverableLazy('window', async () => {
  if (rendererWindow === 'cardling') return { default: (await import('./CardlingWindow')).CardlingWindow };
  if (rendererWindow === 'shadow') return { default: (await import('./ShadowWindow')).ShadowWindow };
  return { default: (await import('./App')).App };
}, (_props, retry) => <DeferredModuleNotice language={language} retry={retry} />);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <React.Suspense fallback={null}>
      <RootWindow />
    </React.Suspense>
  </React.StrictMode>,
);
