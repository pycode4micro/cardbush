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
import { basename, resourceBasename } from '../../shared/localPaths';
import type { InspectorOpenDetail } from './inspectorEvents';
import type { AppLanguage } from '../../types';
import { InspectorErrorBoundary } from './InspectorErrorBoundary';
import { MediaInspectorPreview } from './MediaInspectorPreview';
import { resolveFilePreview } from './filePreviewRegistry';
import { inspectorFilePreviewRenderers } from './inspectorFilePreviewRenderers';
import { DeferredResizePreview } from './DeferredResizePreview';
import {
  normalizeInspectorBrowserAddress,
  inspectorFilePath,
  inspectorMediaTarget,
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
  getTitle?: () => string;
  getURL?: () => string;
  getWebContentsId?: () => number;
  goBack?: () => void;
  goForward?: () => void;
  loadURL?: (url: string) => Promise<void>;
  reload?: () => void;
  setZoomFactor?: (factor: number) => void;
};

export const InspectorWebview = forwardRef<InspectorWebviewHandle, {
  identity: string;
  target: string;
  source: string;
  mediaType?: InspectorOpenDetail['mediaType'];
  title?: string;
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
  mediaType,
  title,
  language,
  onNavigationStateChange,
  onOpenTarget,
}, forwardedRef) {
  const webviewRef = useRef<ElectronInspectorWebview | null>(null);
  const webviewDomReadyRef = useRef(false);
  const requestedUrlRef = useRef(source);
  const filePath = inspectorFilePath(target);
  const media = mediaType ? inspectorMediaTarget(target, mediaType) : null;
  const fileTitle = title?.trim() || resourceBasename(filePath) || media?.kind || basename(filePath);
  const adapter = isInspectorBrowserTarget(target) ? null : resolveFilePreview(filePath);
  const FilePreview = isInspectorBrowserTarget(target) || adapter?.renderer === 'webview'
    ? null : inspectorFilePreviewRenderers[adapter?.renderer ?? 'fallback'];
  const rendererPreview = Boolean(media) || FilePreview !== null;
  const [filePreviewRevision, setFilePreviewRevision] = useState(0);
  const loadingRef = useRef(true);
  const [loading, setLoading] = useState(true);
  const [hasDocument, setHasDocument] = useState(false);
  const [webviewRevision, setWebviewRevision] = useState(0);
  const [previewError, setPreviewError] = useState<'timeout' | 'load' | 'crash' | null>(null);

  useEffect(() => {
    requestedUrlRef.current = source;
  }, [source]);

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
      setPreviewError(null);
      loadingRef.current = true;
      setLoading(true);
      if (rendererPreview) {
        setFilePreviewRevision((value) => value + 1);
        onNavigationStateChange(identity, {
          url: target,
          title: fileTitle,
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
  }), [identity, fileTitle, onNavigationStateChange, publishNavigation, rendererPreview, target]);

  const publishFileNavigation = useCallback((isLoading: boolean) => {
    loadingRef.current = isLoading;
    setLoading(isLoading);
    onNavigationStateChange(identity, {
      url: target,
      title: fileTitle,
      canGoBack: false,
      canGoForward: false,
      loading: isLoading,
    });
  }, [identity, fileTitle, onNavigationStateChange, target]);

  useLayoutEffect(() => {
    if (rendererPreview) return undefined;
    const webview = webviewRef.current;
    if (!webview) return undefined;
    webviewDomReadyRef.current = false;
    let deadline = 0;
    const armDeadline = () => {
      window.clearTimeout(deadline);
      deadline = window.setTimeout(() => {
        setPreviewError('timeout');
        loadingRef.current = false;
        setLoading(false);
        publishNavigation();
      }, 30000);
    };
    setPreviewError(null);
    setHasDocument(false);
    loadingRef.current = true;
    setLoading(true);
    armDeadline();
    const ready = () => {
      webviewDomReadyRef.current = true;
      setHasDocument(true);
      setPreviewError(current => current === 'timeout' ? null : current);
      // Clear zoom inherited from the former fit-to-width behavior. Wide pages
      // keep their normal font size and scroll; resizing never changes zoom.
      try { webview.setZoomFactor?.(1); } catch { /* Guest may be navigating away. */ }
      window.clearTimeout(deadline);
      loadingRef.current = false;
      setLoading(false);
      publishNavigation();
    };
    const start = (event: Event) => {
      const detail = event as Event & { isMainFrame?: boolean; isInPlace?: boolean; url?: string };
      // Lazy frames and in-page navigation can start the browser's spinner too.
      // Only a new top-level document changes this preview's loading lifecycle.
      if (!detail.isMainFrame || detail.isInPlace) return;
      if (detail.url) requestedUrlRef.current = detail.url;
      setPreviewError(null);
      armDeadline();
      loadingRef.current = true;
      setLoading(true);
      publishNavigation();
    };
    const finish = () => {
      window.clearTimeout(deadline);
      loadingRef.current = false;
      setLoading(false);
      publishNavigation();
    };
    const fail = (event: Event) => {
      const detail = event as Event & { isMainFrame?: boolean; errorCode?: number };
      if (detail.isMainFrame === false || detail.errorCode === -3) return;
      window.clearTimeout(deadline);
      setPreviewError(event.type === 'render-process-gone' ? 'crash' : 'load');
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
    const stopOpenLink = window.cardbushDesktop?.onInspectorOpenLink?.((detail) => {
      if (!webview.isConnected) return;
      try {
        if (webview.getWebContentsId?.() !== detail.guestWebContentsId) return;
      } catch { return; } // A guest can be replaced while its IPC event is in flight.
      onOpenTarget({ target: detail.target });
    });
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
    webview.addEventListener('dom-ready', ready);
    webview.addEventListener('did-start-navigation', start);
    webview.addEventListener('did-finish-load', finish);
    webview.addEventListener('did-stop-loading', finish);
    webview.addEventListener('did-fail-load', fail);
    webview.addEventListener('render-process-gone', fail);
    webview.addEventListener('did-navigate', navigate);
    webview.addEventListener('did-navigate-in-page', navigate);
    webview.addEventListener('page-title-updated', updateTitle);
    webview.addEventListener('context-menu', contextMenu);
    return () => {
      stopOpenLink?.();
      window.clearTimeout(deadline);
      webview.removeEventListener('dom-ready', ready);
      webview.removeEventListener('did-start-navigation', start);
      webview.removeEventListener('did-finish-load', finish);
      webview.removeEventListener('did-stop-loading', finish);
      webview.removeEventListener('did-fail-load', fail);
      webview.removeEventListener('render-process-gone', fail);
      webview.removeEventListener('did-navigate', navigate);
      webview.removeEventListener('did-navigate-in-page', navigate);
      webview.removeEventListener('page-title-updated', updateTitle);
      webview.removeEventListener('context-menu', contextMenu);
    };
  }, [
    onOpenTarget,
    publishNavigation,
    rendererPreview,
    source,
    target,
    webviewRevision,
  ]);

  return (
    <DeferredResizePreview className={`right-inspector-preview ${loading ? 'loading' : 'ready'}`}>
      <InspectorErrorBoundary
        key={`${target}:${filePreviewRevision}:${webviewRevision}`}
        target={target}
        language={language}
        onError={() => { loadingRef.current = false; setLoading(false); }}
        onRetry={() => rendererPreview
          ? setFilePreviewRevision(value => value + 1)
          : setWebviewRevision(value => value + 1)}
      >
      {media ? (
        <MediaInspectorPreview
          key={`${target}:${media.kind}:${filePreviewRevision}`}
          kind={media.kind}
          path={media.path}
          source={media.source}
          name={fileTitle}
          language={language}
          onLoadingChange={publishFileNavigation}
        />
      ) : FilePreview ? (
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
          // The main-process handler forwards these requests to inspector tabs and denies native popups.
          allowpopups: '',
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
      {loading && (rendererPreview || !hasDocument) && (
        <div className="right-inspector-preview-loading" role="status">
          <span />
          <span />
          <span />
          <small>{language === 'zh' ? '正在加载预览' : 'Loading preview'}</small>
        </div>
      )}
    </DeferredResizePreview>
  );
});
