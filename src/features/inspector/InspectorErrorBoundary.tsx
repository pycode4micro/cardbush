import { Component, type ErrorInfo, type ReactNode } from 'react';

import type { AppLanguage } from '../../types';
import { showUiError } from '../../shared/showUiError';

export class InspectorErrorBoundary extends Component<{
  children: ReactNode;
  target: string;
  language: AppLanguage;
  onError: () => void;
  onRetry: () => void;
}, { message: string }> {
  state = { message: '' };

  static getDerivedStateFromError(error: unknown) {
    return { message: (error instanceof Error ? error.message : String(error)) || 'Unknown preview error' };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.props.onError();
    void window.cardbushDesktop?.writeDebugLog?.('renderer-lifecycle', {
      stage: 'inspector-render-error', target: this.props.target,
      error: String(error), componentStack: info.componentStack,
    }).catch(() => undefined);
    void showUiError(
      this.props.language === 'zh' ? '无法显示预览' : 'Unable to display preview',
      `${this.props.target}\n\n${this.state.message}`,
    );
  }

  render() {
    if (!this.state.message) return this.props.children;
    return <div className="inspector-preview-error" role="alert">
      <p>{this.state.message}</p>
      <button type="button" onClick={this.props.onRetry}>
        {this.props.language === 'zh' ? '重试预览' : 'Retry preview'}
      </button>
    </div>;
  }
}
