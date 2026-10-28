import { uiText } from '../i18n';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { showUiError } from '../shared/showUiError';

type AppErrorBoundaryState = {
  message: string;
};

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { message: '' };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      message: (error instanceof Error ? error.message : String(error)) || uiText()('appErrorBoundary.unknown_rendering_error'),
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('CardBush render error', error, info);
    void window.cardbushDesktop?.writeDebugLog('renderer-lifecycle', {
      stage: 'react-error-boundary',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      componentStack: info.componentStack,
    }).catch(() => undefined);
    void showUiError(uiText()('appErrorBoundary.cardbush_interface_error'), uiText()('appErrorBoundary.value1_the_app_was_not_reloaded_automatically', { value1: this.state.message }));
  }

  render() {
    if (!this.state.message) {
      return this.props.children;
    }
    return (
      <div className="app theme-dark">
        <div className="render-failure-shell">
          <section className="render-failure-card" role="alert" aria-label={uiText()('appErrorBoundary.cardbush_interface_error')}>
            <h1>{uiText()('appErrorBoundary.cardbush_rendering_error')}</h1>
            <p>{this.state.message}</p>
            <p>{uiText()('appErrorBoundary.the_app_was_not_reloaded_automatically_close')}</p>
          </section>
        </div>
      </div>
    );
  }
}