import {
  createElement,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { basename } from '../../shared/localPaths';
import type { InspectorOpenDetail } from './inspectorEvents';
import type { AppLanguage } from '../../types';
import { InspectorErrorBoundary } from './InspectorErrorBoundary';
import { resolveFilePreview } from './filePreviewRegistry';
import { inspectorFilePreviewRenderers } from './inspectorFilePreviewRenderers';
import {
  normalizeInspectorBrowserAddress,
  inspectorFilePath,
  isInspectorBrowserTarget,
} from './inspectorTargets';

export type InspectorNavigationState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
};

export type InspectorWebviewHandle = {
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  navigate: (address: string) => void;
};

type ElectronInspectorWebview = HTMLElement & {
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
  getTitle?: () => string;
  getURL?: () => string;
  getWebContentsId?: () => number;
  goBack?: () => void;
  goForward?: () => void;
  loadURL?: (url: string) => Promise<void>;
  reload?: () => void;
  setZoomFactor?: (factor: number) => void;
};

type InspectorBrowserViewportMeasurement = {
  viewportWidth: number;
  contentWidth: number;
};

const inspectorBrowserViewportMeasurementScript = `(() => {
  const root = document.documentElement;
  const body = document.body;
  const viewportWidth = Math.max(0, window.innerWidth || root?.clientWidth || 0);
  const contentWidth = Math.max(
    viewportWidth,
    root?.scrollWidth || 0,
    body?.scrollWidth || 0
  );
  return { viewportWidth, contentWidth };
})()`;

function inspectorBrowserFitZoom(measurement: unknown) {
  if (!measurement || typeof measurement !== 'object') return 1;
  const value = measurement as Partial<InspectorBrowserViewportMeasurement>;
  const viewportWidth = Number(value.viewportWidth);
  const contentWidth = Number(value.contentWidth);
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(contentWidth) ||
    viewportWidth <= 0 ||
    contentWidth <= viewportWidth + 2
  ) {
    return 1;
  }
  return Math.max(0.5, Math.min(1, viewportWidth / contentWidth));
}

export const InspectorWebview = forwardRef<InspectorWebviewHandle, {
  identity: string;
  target: string;
  source: string;
  language: AppLanguage;
  onNavigationStateChange: (
    identity: string,
    navigation: InspectorNavigationState,
  ) => void;
  onOpenTarget: (detail: InspectorOpenDetail) => void;
}>(function InspectorWebview({
  identity,
  target,
  source,
  language,
  onNavigationStateChange,
  onOpenTarget,
}, forwardedRef) {
  const webviewRef = useRef<ElectronInspectorWebview | null>(null);
  const webviewDomReadyRef = useRef(false);
  const browserFitRevisionRef = useRef(0);
  const browserFitTimerRef = useRef(0);
  const requestedUrlRef = useRef(source);
  const filePath = inspectorFilePath(target);
  const adapter = isInspectorBrowserTarget(target) ? null : resolveFilePreview(filePath);
  const FilePreview = isInspectorBrowserTarget(target) || adapter?.renderer === 'webview'
    ? null : inspectorFilePreviewRenderers[adapter?.renderer ?? 'fallback'];
  const rendererPreview = FilePreview !== null;
  const [filePreviewRevision, setFilePreviewRevision] = useState(0);
  const loadingRef = useRef(true);
  const [loading, setLoading] = useState(true);
  const [webviewRevision, setWebviewRevision] = useState(0);
  const [previewError, setPreviewError] = useState(false);

  useEffect(() => {
    requestedUrlRef.current = source;
  }, [source]);

  const applyBrowserViewportFit = useCallback(async (revision: number) => {
    const webview = webviewRef.current;
    if (
      rendererPreview ||
      !webview?.isConnected ||
      !webviewDomReadyRef.current ||
      webview.getBoundingClientRect().width <= 0
    ) {
      return;
    }
    try {
      // Measure at the natural page scale so responsive pages remain at 100%,
      // while fixed-width desktop pages are fitted into the inspector viewport.
      webview.setZoomFactor?.(1);
      const measurement = await webview.executeJavaScript?.(
        inspectorBrowserViewportMeasurementScript,
      );
      if (
        revision !== browserFitRevisionRef.current ||
        webview !== webviewRef.current ||
        !webview.isConnected ||
        !webviewDomReadyRef.current
      ) {
        return;
      }
      webview.setZoomFactor?.(inspectorBrowserFitZoom(measurement));
    } catch {
      // A navigation can dispose the guest while an async measurement is in
      // flight. The next dom-ready/resize observation will retry safely.
    }
  }, [rendererPreview]);

  const scheduleBrowserViewportFit = useCallback((delay = 0) => {
    const revision = browserFitRevisionRef.current + 1;
    browserFitRevisionRef.current = revision;
    if (browserFitTimerRef.current) {
      window.clearTimeout(browserFitTimerRef.current);
    }
    browserFitTimerRef.current = window.setTimeout(() => {
      browserFitTimerRef.current = 0;
      void applyBrowserViewportFit(revision);
    }, delay);
  }, [applyBrowserViewportFit]);

  const publishNavigation = useCallback(() => {
    const webview = webviewRef.current;
    const fallbackNavigation: InspectorNavigationState = {
      url: requestedUrlRef.current || source,
      title: '',
      canGoBack: false,
      canGoForward: false,
      loading: loadingRef.current,
    };
    if (!webview?.isConnected || !webviewDomReadyRef.current) {
      onNavigationStateChange(identity, fallbackNavigation);
      return;
    }
    try {
      const url = webview.getURL?.() || fallbackNavigation.url;
      requestedUrlRef.current = url;
      onNavigationStateChange(identity, {
        url,
        title: webview.getTitle?.().trim() || '',
        canGoBack: webview.canGoBack?.() ?? false,
        canGoForward: webview.canGoForward?.() ?? false,
        loading: loadingRef.current,
      });
    } catch {
      // Electron throws when a <webview> is queried between React mounting and
      // its native guest being ready. Keep the inspector state usable without
      // allowing that lifecycle race to crash the whole renderer.
      webviewDomReadyRef.current = false;
      onNavigationStateChange(identity, fallbackNavigation);
    }
  }, [identity, onNavigationStateChange, source]);

  useImperativeHandle(forwardedRef, () => ({
    goBack: () => {
      const webview = webviewRef.current;
      if (!webview?.isConnected || !webviewDomReadyRef.current) return;
      try {
        if (webview.canGoBack?.()) webview.goBack?.();
      } catch {
        webviewDomReadyRef.current = false;
        publishNavigation();
      }
    },
    goForward: () => {
      const webview = webviewRef.current;
      if (!webview?.isConnected || !webviewDomReadyRef.current) return;
      try {
        if (webview.canGoForward?.()) webview.goForward?.();
      } catch {
        webviewDomReadyRef.current = false;
        publishNavigation();
      }
    },
    reload: () => {
      setPreviewError(false);
      loadingRef.current = true;
      setLoading(true);
      if (rendererPreview) {
        setFilePreviewRevision((value) => value + 1);
        onNavigationStateChange(identity, {
          url: target,
          title: basename(filePath),
          canGoBack: false,
          canGoForward: false,
          loading: true,
        });
      } else {
        const webview = webviewRef.current;
        if (!webview?.isConnected || !webviewDomReadyRef.current) {
          setWebviewRevision((value) => value + 1);
          publishNavigation();
          return;
        }
        try {
          webview.reload?.();
        } catch {
          webviewDomReadyRef.current = false;
        }
        publishNavigation();
      }
    },
    navigate: (address) => {
      const destination = normalizeInspectorBrowserAddress(address);
      const webview = webviewRef.current;
      if (!destination || !webview || rendererPreview) return;
      requestedUrlRef.current = destination;
      loadingRef.current = true;
      setLoading(true);
      if (!webview.isConnected || !webviewDomReadyRef.current) {
        webview.setAttribute('src', destination);
        publishNavigation();
        return;
      }
      try {
        if (webview.loadURL) {
          void webview.loadURL(destination).catch(() => {
            loadingRef.current = false;
            setLoading(false);
            publishNavigation();
          });
        } else {
          webview.setAttribute('src', destination);
        }
      } catch {
        webviewDomReadyRef.current = false;
        loadingRef.current = false;
        setLoading(false);
        publishNavigation();
      }
    },
  }), [identity, filePath, onNavigationStateChange, publishNavigation, rendererPreview, target]);

  const publishFileNavigation = useCallback((isLoading: boolean) => {
    loadingRef.current = isLoading;
    setLoading(isLoading);
    onNavigationStateChange(identity, {
      url: target,
      title: basename(filePath),
      canGoBack: false,
      canGoForward: false,
      loading: isLoading,
    });
  }, [identity, filePath, onNavigationStateChange, target]);

  useLayoutEffect(() => {
    if (rendererPreview) return undefined;
    const webview = webviewRef.current;
    if (!webview) return undefined;
    webviewDomReadyRef.current = false;
    let deadline = 0;
    const armDeadline = () => {
      window.clearTimeout(deadline);
      deadline = window.setTimeout(() => {
        setPreviewError(true);
        loadingRef.current = false;
        setLoading(false);
        publishNavigation();
      }, 30000);
    };
    setPreviewError(false);
    loadingRef.current = true;
    setLoading(true);
    armDeadline();
    const ready = () => {
      webviewDomReadyRef.current = true;
      window.clearTimeout(deadline);
      loadingRef.current = false;
      setLoading(false);
      publishNavigation();
      scheduleBrowserViewportFit();
    };
    const start = () => {
      setPreviewError(false);
      armDeadline();
      browserFitRevisionRef.current += 1;
      if (browserFitTimerRef.current) {
        window.clearTimeout(browserFitTimerRef.current);
        browserFitTimerRef.current = 0;
      }
      try {
        webview.setZoomFactor?.(1);
      } catch {
        webviewDomReadyRef.current = false;
      }
      loadingRef.current = true;
      setLoading(true);
      publishNavigation();
    };
    const finish = () => {
      window.clearTimeout(deadline);
      loadingRef.current = false;
      setLoading(false);
      publishNavigation();
      scheduleBrowserViewportFit(80);
    };
    const fail = (event: Event) => {
      const detail = event as Event & { isMainFrame?: boolean; errorCode?: number };
      if (detail.isMainFrame === false || detail.errorCode === -3) return;
      window.clearTimeout(deadline);
      setPreviewError(true);
      loadingRef.current = false;
      setLoading(false);
      publishNavigation();
    };
    const navigate = (event: Event) => {
      const url = (event as Event & { url?: string }).url?.trim();
      if (url) requestedUrlRef.current = url;
      publishNavigation();
    };
    const updateTitle = () => publishNavigation();
    const openWindow = (event: Event) => {
      const target = (event as Event & { url?: string }).url?.trim();
      if (!target) return;
      event.preventDefault();
      onOpenTarget({ target, title: target });
    };
    const contextMenu = (event: Event) => {
      const params = (event as Event & {
        params?: {
          x?: number;
          y?: number;
          mediaType?: string;
          srcURL?: string;
          linkURL?: string;
          selectionText?: string;
          isEditable?: boolean;
        };
      }).params;
      if (!webview.isConnected || !webviewDomReadyRef.current) return;
      let guestWebContentsId: number | undefined;
      try {
        guestWebContentsId = webview.getWebContentsId?.();
      } catch {
        webviewDomReadyRef.current = false;
        return;
      }
      if (!params || !guestWebContentsId) return;
      event.preventDefault();
      void window.cardbushDesktop?.showInspectorContextMenu?.({
        guestWebContentsId,
        target,
        x: Number(params.x) || 0,
        y: Number(params.y) || 0,
        mediaType: params.mediaType,
        srcURL: params.srcURL,
        linkURL: params.linkURL,
        selectionText: params.selectionText,
        isEditable: params.isEditable,
      });
    };
    const resizeObserver = new ResizeObserver((entries) => {
      if ((entries[0]?.contentRect.width ?? 0) > 0) {
        scheduleBrowserViewportFit(120);
      }
    });
    resizeObserver.observe(webview);
    webview.addEventListener('dom-ready', ready);
    webview.addEventListener('did-start-loading', start);
    webview.addEventListener('did-finish-load', finish);
    webview.addEventListener('did-stop-loading', finish);
    webview.addEventListener('did-fail-load', fail);
    webview.addEventListener('render-process-gone', fail);
    webview.addEventListener('did-navigate', navigate);
    webview.addEventListener('did-navigate-in-page', navigate);
    webview.addEventListener('page-title-updated', updateTitle);
    webview.addEventListener('new-window', openWindow);
    webview.addEventListener('context-menu', contextMenu);
    return () => {
      window.clearTimeout(deadline);
      browserFitRevisionRef.current += 1;
      if (browserFitTimerRef.current) {
        window.clearTimeout(browserFitTimerRef.current);
        browserFitTimerRef.current = 0;
      }
      resizeObserver.disconnect();
      webview.removeEventListener('dom-ready', ready);
      webview.removeEventListener('did-start-loading', start);
      webview.removeEventListener('did-finish-load', finish);
      webview.removeEventListener('did-stop-loading', finish);
      webview.removeEventListener('did-fail-load', fail);
      webview.removeEventListener('render-process-gone', fail);
      webview.removeEventListener('did-navigate', navigate);
      webview.removeEventListener('did-navigate-in-page', navigate);
      webview.removeEventListener('page-title-updated', updateTitle);
      webview.removeEventListener('new-window', openWindow);
      webview.removeEventListener('context-menu', contextMenu);
    };
  }, [
    onOpenTarget,
    publishNavigation,
    rendererPreview,
    scheduleBrowserViewportFit,
    source,
    target,
    webviewRevision,
  ]);

  return (
    <div className={`right-inspector-preview ${loading ? 'loading' : 'ready'}`}>
      <InspectorErrorBoundary
        key={`${target}:${filePreviewRevision}:${webviewRevision}`}
        target={target}
        language={language}
        onError={() => { loadingRef.current = false; setLoading(false); }}
        onRetry={() => rendererPreview
          ? setFilePreviewRevision(value => value + 1)
          : setWebviewRevision(value => value + 1)}
      >
      {FilePreview ? (
        <FilePreview
          key={`${filePath}:${filePreviewRevision}`}
          path={filePath}
          source={source}
          language={language}
          onLoadingChange={publishFileNavigation}
        />
      ) : createElement('webview', {
          key: webviewRevision,
          ref: webviewRef,
          className: 'right-inspector-webview',
          src: source,
          webpreferences: 'contextIsolation=yes,nodeIntegration=no,sandbox=yes',
        })}
      </InspectorErrorBoundary>
      {!rendererPreview && previewError && (
        <div className="inspector-preview-error" role="alert">
          <p>{language === 'zh' ? '无法加载预览，文件可能不可用、格式不受支持，或加载已超时。' : 'Preview unavailable. The file may be missing, unsupported, or taking too long to load.'}</p>
          <button type="button" onClick={() => setWebviewRevision(value => value + 1)}>
            {language === 'zh' ? '重试' : 'Retry'}
          </button>
        </div>
      )}
      {loading && (
        <div className="right-inspector-preview-loading" role="status">
          <span />
          <span />
          <span />
          <small>{language === 'zh' ? '正在加载预览' : 'Loading preview'}</small>
        </div>
      )}
    </div>
  );
});
