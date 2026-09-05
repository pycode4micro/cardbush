import {
  createElement,
  forwardRef,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { MarkdownContent, MessageFileReferenceScope } from '../chatMessages';
import { basename } from '../../shared/localPaths';
import { shouldUsePlainTextPreview, textPreviewErrorMessage } from '../../shared/textPreview';
import type { InspectorOpenDetail } from './inspectorEvents';
import type { AppLanguage } from '../../types';
import {
  normalizeInspectorBrowserAddress,
  inspectorMarkdownPath,
  isMarkdownInspectorTarget,
  parentDirectory,
} from './inspectorTargets';

const SourceSyntaxLines = lazy(() => import('../tools/SourceSyntaxLines'));

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
  const markdownPath = inspectorMarkdownPath(target);
  const markdownPreview = isMarkdownInspectorTarget(target);
  const sourcePreview = !markdownPreview && /^cardbush-file:\/\/text-preview(?:\/|\?|$)/i.test(source);
  const rendererPreview = markdownPreview || sourcePreview;
  const [markdownRevision, setMarkdownRevision] = useState(0);
  const loadingRef = useRef(true);
  const [loading, setLoading] = useState(true);

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
      loadingRef.current = true;
      setLoading(true);
      if (rendererPreview) {
        setMarkdownRevision((value) => value + 1);
        onNavigationStateChange(identity, {
          url: target,
          title: basename(markdownPath),
          canGoBack: false,
          canGoForward: false,
          loading: true,
        });
      } else {
        const webview = webviewRef.current;
        if (!webview?.isConnected || !webviewDomReadyRef.current) {
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
  }), [identity, markdownPath, onNavigationStateChange, publishNavigation, rendererPreview, target]);

  const publishMarkdownNavigation = useCallback((isLoading: boolean) => {
    loadingRef.current = isLoading;
    setLoading(isLoading);
    onNavigationStateChange(identity, {
      url: target,
      title: basename(markdownPath),
      canGoBack: false,
      canGoForward: false,
      loading: isLoading,
    });
  }, [identity, markdownPath, onNavigationStateChange, target]);

  useEffect(() => {
    if (rendererPreview) return undefined;
    const webview = webviewRef.current;
    if (!webview) return undefined;
    const ready = () => {
      webviewDomReadyRef.current = true;
      publishNavigation();
      scheduleBrowserViewportFit();
    };
    const start = () => {
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
      loadingRef.current = false;
      setLoading(false);
      publishNavigation();
      scheduleBrowserViewportFit(80);
    };
    const fail = () => {
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
    webview.addEventListener('did-fail-load', fail);
    webview.addEventListener('did-navigate', navigate);
    webview.addEventListener('did-navigate-in-page', navigate);
    webview.addEventListener('page-title-updated', updateTitle);
    webview.addEventListener('new-window', openWindow);
    webview.addEventListener('context-menu', contextMenu);
    return () => {
      browserFitRevisionRef.current += 1;
      if (browserFitTimerRef.current) {
        window.clearTimeout(browserFitTimerRef.current);
        browserFitTimerRef.current = 0;
      }
      resizeObserver.disconnect();
      webview.removeEventListener('dom-ready', ready);
      webview.removeEventListener('did-start-loading', start);
      webview.removeEventListener('did-finish-load', finish);
      webview.removeEventListener('did-fail-load', fail);
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
  ]);

  return (
    <div className={`right-inspector-preview ${loading ? 'loading' : 'ready'}`}>
      {markdownPreview ? (
        <MarkdownInspectorPreview
          key={`${markdownPath}:${markdownRevision}`}
          path={markdownPath}
          language={language}
          onLoadingChange={publishMarkdownNavigation}
        />
      ) : sourcePreview ? (
        <SourceInspectorPreview
          key={`${markdownPath}:${markdownRevision}`}
          path={markdownPath}
          language={language}
          onLoadingChange={publishMarkdownNavigation}
        />
      ) : createElement('webview', {
          ref: webviewRef,
          className: 'right-inspector-webview',
          src: source,
          webpreferences: 'contextIsolation=yes,nodeIntegration=no,sandbox=yes',
        })}
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

function MarkdownInspectorPreview({
  path,
  language,
  onLoadingChange,
}: {
  path: string;
  language: AppLanguage;
  onLoadingChange: (loading: boolean) => void;
}) {
  const [content, setContent] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [encoding, setEncoding] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    onLoadingChange(true);
    setError('');
    setContent('');
    setTruncated(false);
    setEncoding('');
    const readTextPreview = window.cardbushDesktop?.readTextPreview;
    if (!readTextPreview) {
      setError(language === 'zh' ? '当前环境不支持本地 Markdown 预览。' : 'Local Markdown preview is unavailable.');
      onLoadingChange(false);
      return () => {
        disposed = true;
      };
    }
    void readTextPreview(path)
      .then((result) => {
        if (disposed) return;
        setContent(result.content);
        setTruncated(result.truncated);
        setEncoding(result.encoding ?? '');
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        setError(textPreviewErrorMessage(reason, language));
      })
      .finally(() => {
        if (!disposed) onLoadingChange(false);
      });
    return () => {
      disposed = true;
    };
  }, [language, onLoadingChange, path]);

  return (
    <article className="markdown-inspector-preview">
      <div className="markdown-inspector-document">
        {error ? (
          <div className="markdown-inspector-error" role="alert">{error}</div>
        ) : (
          <>
            {encoding === 'gb18030' && <div className="inspector-preview-notice">
              {language === 'zh' ? '按 GB18030 编码预览，原文件未修改。' : 'Preview decoded as GB18030; original file unchanged.'}
            </div>}
            {truncated && (
              <div className="inspector-preview-notice">
                {language === 'zh' ? '文件较大，仅显示前 2 MiB' : 'Large file · showing the first 2 MiB'}
              </div>
            )}
            {shouldUsePlainTextPreview(content) ? <Suspense fallback={null}>
              <SourceSyntaxLines content={content} path={path} language={language} />
            </Suspense> : <MessageFileReferenceScope workspaceRoot={parentDirectory(path)}>
              <MarkdownContent content={content} language={language} />
            </MessageFileReferenceScope>}
          </>
        )}
      </div>
    </article>
  );
}

function SourceInspectorPreview({
  path,
  language,
  onLoadingChange,
}: {
  path: string;
  language: AppLanguage;
  onLoadingChange: (loading: boolean) => void;
}) {
  const [content, setContent] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [encoding, setEncoding] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    onLoadingChange(true);
    setError('');
    setContent('');
    setTruncated(false);
    setEncoding('');
    const readTextPreview = window.cardbushDesktop?.readTextPreview;
    if (!readTextPreview) {
      setError(language === 'zh' ? '当前环境不支持本地源码预览。' : 'Local source preview is unavailable.');
      onLoadingChange(false);
      return () => {
        disposed = true;
      };
    }
    void readTextPreview(path)
      .then((result) => {
        if (disposed) return;
        setContent(result.content);
        setTruncated(result.truncated);
        setEncoding(result.encoding ?? '');
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        setError(textPreviewErrorMessage(reason, language));
      })
      .finally(() => {
        if (!disposed) onLoadingChange(false);
      });
    return () => {
      disposed = true;
    };
  }, [language, onLoadingChange, path]);

  return (
    <article className="source-inspector-preview">
      <div className="source-inspector-document">
        {error ? (
          <div className="markdown-inspector-error" role="alert">{error}</div>
        ) : (
          <>
            {encoding === 'gb18030' && <div className="inspector-preview-notice source">
              {language === 'zh' ? '按 GB18030 编码预览，原文件未修改。' : 'Preview decoded as GB18030; original file unchanged.'}
            </div>}
            {truncated && (
              <div className="inspector-preview-notice source">
                {language === 'zh' ? '文件较大，仅显示前 2 MiB' : 'Large file · showing the first 2 MiB'}
              </div>
            )}
            <Suspense fallback={null}>
              <SourceSyntaxLines content={content} path={path} language={language} />
            </Suspense>
          </>
        )}
      </div>
    </article>
  );
}
