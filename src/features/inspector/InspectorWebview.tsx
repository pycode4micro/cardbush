import {
  createElement,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { basename, resourceBasename, resourceTargetKind } from '../../shared/localPaths';
import type { InspectorOpenDetail } from './inspectorEvents';
import type { AppLanguage } from '../../types';
import { InspectorErrorBoundary } from './InspectorErrorBoundary';
import { MediaInspectorPreview } from './MediaInspectorPreview';
import { resolveFilePreview } from './filePreviewRegistry';
import { inspectorFilePreviewRenderers } from './inspectorFilePreviewRenderers';
import { DeferredResizePreview } from './DeferredResizePreview';
import { BrowserPageTools, type BrowserPageToolsHandle } from '../browser/BrowserPageTools';
import { browserIconUrl, rememberBrowserSiteIcon } from '../browser/browserSiteIcons';
import {
  normalizeInspectorBrowserAddress,
  inspectorFilePath,
  inspectorMediaTarget,
  isInspectorBrowserTarget,
} from './inspectorTargets';

export type InspectorNavigationState = {
  guestWebContentsId?: number;
  url: string;
  title: string;
  faviconUrl?: string;
  audible?: boolean;
  audioMuted?: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
};

export type InspectorWebviewHandle = {
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  navigate: (address: string) => void;
  find?: () => void;
  toggleDevice?: () => void;
  toggleAudioMuted?: () => void;
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
  isCurrentlyAudible?: () => boolean;
  isAudioMuted?: () => boolean;
  setAudioMuted?: (muted: boolean) => void;
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
  onActivate?: (identity: string) => void;
  startPage?: ReactNode;
}>(function InspectorWebview({
  identity,
  target,
  source,
  mediaType,
  title,
  language,
  onNavigationStateChange,
  onOpenTarget,
  onActivate,
  startPage,
}, forwardedRef) {
  const webviewRef = useRef<ElectronInspectorWebview | null>(null);
  const toolsRef = useRef<BrowserPageToolsHandle>(null);
  const activateRef = useRef(onActivate); activateRef.current = onActivate;
  const languageRef = useRef(language); languageRef.current = language;
  const webviewDomReadyRef = useRef(false);
  const requestedUrlRef = useRef(source);
  const faviconRef = useRef<{ page: string; icon: string } | null>(null);
  const [currentUrl, setCurrentUrl] = useState(source);
  const filePath = inspectorFilePath(target);
  const media = mediaType ? inspectorMediaTarget(target, mediaType) : null;
  const fileTitle = title?.trim() || resourceBasename(filePath) || media?.kind || basename(filePath);
  const resourceKind = resourceTargetKind(filePath);
  const adapter = isInspectorBrowserTarget(target) || (resourceKind !== 'local-file' && resourceKind !== 'ssh-file')
    ? null : resolveFilePreview(filePath);
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
      setCurrentUrl(fallbackNavigation.url);
      onNavigationStateChange(identity, fallbackNavigation);
      return;
    }
    try {
      const url = webview.getURL?.() || fallbackNavigation.url;
      requestedUrlRef.current = url;
      setCurrentUrl(url);
      onNavigationStateChange(identity, {
        guestWebContentsId: webview.getWebContentsId?.(),
        url,
        title: /^about:blank(?:[?#]|$)/i.test(url) ? (languageRef.current === 'zh' ? '新标签页' : 'New tab') : webview.getTitle?.().trim() || '',
        faviconUrl: faviconRef.current?.page === url ? faviconRef.current.icon : undefined,
        audible: webview.isCurrentlyAudible?.() ?? false,
        audioMuted: webview.isAudioMuted?.() ?? false,
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
  useEffect(() => { if (!rendererPreview) publishNavigation(); }, [publishNavigation, rendererPreview, language]);

  useImperativeHandle(forwardedRef, () => ({
    find: () => toolsRef.current?.find(),
    toggleDevice: () => toolsRef.current?.toggleDevice(),
    toggleAudioMuted: () => {
      const webview = webviewRef.current;
      if (!webview?.isConnected || !webviewDomReadyRef.current) return;
      try {
        webview.setAudioMuted?.(!webview.isAudioMuted?.());
        publishNavigation();
      } catch { /* A tab can close or replace its guest during the click. */ }
    },
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
      // Browser zoom belongs to the site/user, and survives document navigation.
      if (!isInspectorBrowserTarget(target, mediaType)) {
        try { webview.setZoomFactor?.(1); } catch { /* Guest may be navigating away. */ }
      }
      window.clearTimeout(deadline);
      loadingRef.current = false;
      setLoading(false);
      publishNavigation();
      if (isInspectorBrowserTarget(target, mediaType)) {
        try {
          const guestWebContentsId = webview.getWebContentsId?.();
          if (guestWebContentsId) void window.cardbushDesktop?.registerInspectorBrowser?.({ tabId: identity, guestWebContentsId }).catch(() => {});
        } catch { /* A closing or replaced guest is registered by the next dom-ready. */ }
      }
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
      if (event.type === 'render-process-gone') webviewDomReadyRef.current = false;
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
    const updateFavicon = (event: Event) => {
      if (!webview.isConnected || !webviewDomReadyRef.current) return;
      try {
        const page = webview.getURL?.() || '';
        const candidates = (event as Event & { favicons?: string[] }).favicons;
        const icon = candidates?.map(browserIconUrl).find(Boolean);
        if (!icon || !/^https?:\/\//i.test(page)) return;
        faviconRef.current = { page, icon };
        rememberBrowserSiteIcon(page, icon);
        publishNavigation();
      } catch { /* A favicon update can race with guest teardown. */ }
    };
    const stopAudio = window.cardbushDesktop?.browser?.onAudioStateChanged?.(guestId => {
      if (!webview.isConnected || !webviewDomReadyRef.current) return;
      try { if (webview.getWebContentsId?.() === guestId) publishNavigation(); }
      catch { /* Ignore audio notifications from a closing/replaced guest. */ }
    });
    const stopActivation = window.cardbushDesktop?.onInspectorGuestActivated?.(detail => {
      if (!webview.isConnected || !webviewDomReadyRef.current) return;
      try { if (webview.getWebContentsId?.() === detail.guestWebContentsId) activateRef.current?.(identity); }
      catch { /* The guest may have closed while its activation was in flight. */ }
    });
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
    webview.addEventListener('page-favicon-updated', updateFavicon);
    webview.addEventListener('context-menu', contextMenu);
    return () => {
      try {
        const guestWebContentsId = webview.getWebContentsId?.();
        if (guestWebContentsId) void window.cardbushDesktop?.unregisterInspectorBrowser?.({ tabId: identity, guestWebContentsId }).catch(() => {});
      } catch { /* The main process also removes destroyed guests. */ }
      stopActivation?.();
      stopOpenLink?.();
      stopAudio?.();
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
      webview.removeEventListener('page-favicon-updated', updateFavicon);
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

  const showStartPage = Boolean(startPage) && isInspectorBrowserTarget(target, mediaType)
    && /^about:blank(?:[?#]|$)/i.test(currentUrl) && !previewError && (!loading || !hasDocument);
  return (
    <DeferredResizePreview className={`right-inspector-preview ${loading ? 'loading' : 'ready'}${showStartPage ? ' showing-start-page' : ''}`}>
      {!rendererPreview && isInspectorBrowserTarget(target, mediaType) && <BrowserPageTools ref={toolsRef} webviewRef={webviewRef} revision={webviewRevision} language={language}/>}
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
      {showStartPage && <div className="inspector-new-tab-page">{startPage}</div>}
      {!rendererPreview && previewError && (
        <div className="inspector-preview-error" role="alert">
          <p>{language === 'zh' ? '无法加载预览，文件可能不可用、格式不受支持，或加载已超时。' : 'Preview unavailable. The file may be missing, unsupported, or taking too long to load.'}</p>
          <button type="button" onClick={() => setWebviewRevision(value => value + 1)}>
            {language === 'zh' ? '重试' : 'Retry'}
          </button>
        </div>
      )}
      {!showStartPage && loading && (rendererPreview || !hasDocument) && (
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
