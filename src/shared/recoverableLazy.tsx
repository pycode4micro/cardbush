import { Component, lazy, useState, type ComponentType, type ReactNode } from 'react';

class ModuleLoadError extends Error {
  constructor(readonly moduleName: string, cause: unknown) {
    super(`Unable to load ${moduleName}`, { cause });
  }
}

class ModuleLoadBoundary extends Component<{
  children: ReactNode;
  fallback: () => ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(error: unknown) {
    // Keep actual rendering bugs visible to the owning feature's boundary.
    if (!(error instanceof ModuleLoadError)) throw error;
    return { failed: true };
  }

  componentDidCatch(error: ModuleLoadError) {
    void window.cardbushDesktop?.writeDebugLog?.('renderer-lifecycle', {
      stage: 'deferred-module-unavailable',
      module: error.moduleName,
      error: error.cause instanceof Error ? error.cause.message : String(error.cause),
    }).catch(() => undefined);
  }

  render() {
    return this.state.failed ? this.props.fallback() : this.props.children;
  }
}

// A rejected React.lazy promise is cached. A retry needs both a fresh lazy
// component and a fresh boundary, without remounting the surrounding workspace.
export function recoverableLazy<P extends object>(
  name: string,
  load: () => Promise<{ default: ComponentType<P> }>,
  fallback: (props: P, retry: () => void) => ReactNode,
) {
  const createLazy = () => lazy(async () => {
    try {
      return await load();
    } catch (cause) {
      throw new ModuleLoadError(name, cause);
    }
  });
  // React discards hooks from an initial suspended render. Share the initial
  // identity outside the render, or every replay would start loading again.
  let sharedComponent = createLazy();
  function DeferredComponent(props: P) {
    const [{ Loaded, attempt }, setLoad] = useState(() => ({ Loaded: sharedComponent, attempt: 0 }));
    const retry = () => {
      sharedComponent = createLazy();
      setLoad({ Loaded: sharedComponent, attempt: attempt + 1 });
    };
    return (
      <ModuleLoadBoundary key={attempt} fallback={() => fallback(props, retry)}>
        <Loaded {...props} />
      </ModuleLoadBoundary>
    );
  }
  return DeferredComponent;
}

export function DeferredModuleNotice({
  language,
  retry,
  basicPreview = false,
}: {
  language: 'zh' | 'en';
  retry?: () => void;
  basicPreview?: boolean;
}) {
  return (
    <div className="deferred-module-notice" role="status">
      <span>{basicPreview
        ? language === 'zh' ? '已显示基本预览' : 'Showing a basic preview'
        : language === 'zh' ? '此面板暂时无法加载' : 'This panel is temporarily unavailable'}</span>
      {retry && <button type="button" onClick={retry}>{language === 'zh' ? '重试' : 'Retry'}</button>}
    </div>
  );
}
