import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import { CardlingWindow } from './CardlingWindow';
import { ShadowWindow } from './ShadowWindow';
import './styles/theme.css';
import './styles/app.css';

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {rendererWindow === 'cardling' ? (
      <CardlingWindow />
    ) : rendererWindow === 'shadow' ? (
      <ShadowWindow />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
