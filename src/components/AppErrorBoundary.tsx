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
      message: (error instanceof Error ? error.message : String(error)) || '未知渲染错误',
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('CardBush render error', error, info);
    void window.cardbushDesktop?.writeDebugLog('renderer-lifecycle', {
      stage: 'react-error-boundary',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      componentStack: info.componentStack,
    }).catch(() => undefined);
    void showUiError('CardBush 界面异常', `${this.state.message}\n应用未自动重新加载。请关闭窗口后手动重新打开。`);
  }

  render() {
    if (!this.state.message) {
      return this.props.children;
    }
    return (
      <div className="app theme-dark">
        <div className="render-failure-shell">
          <section className="render-failure-card" role="alert" aria-label="CardBush 界面异常">
            <h1>CardBush 渲染异常</h1>
            <p>{this.state.message}</p>
            <p>应用未自动重新加载。请关闭窗口后手动重新打开。</p>
          </section>
        </div>
      </div>
    );
  }
}