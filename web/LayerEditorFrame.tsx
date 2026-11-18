import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { uiText } from '../src/i18n';
import { useUiLanguage } from '../src/i18n/react';
import { personalFilePath } from './personalFiles';
import { layerCommand, uploadLayerImage } from './layerService';

type Panel = { _meta?: { seedream_layers?: unknown }; structuredContent?: { path?: string } };
const endpoint = '/api/web/v1/layers/editor';

export function LayerEditorFrame({ project, owner, back }: { project: string; owner: string; back: () => void }) {
  const language = useUiLanguage(), t = uiText(language);
  const frame = useRef<HTMLIFrameElement>(null);
  const currentLanguage = useRef(language);
  currentLanguage.current = language;
  const [ready, setReady] = useState(false), [error, setError] = useState(false);
  const [reload, setReload] = useState(0);

  useLayoutEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    const downloads = new Set<string>();
    let initialized = false;
    const notify = (method: string, params: unknown) => frame.current?.contentWindow?.postMessage({ jsonrpc: '2.0', method, params }, '*');
    const request = (args: Record<string, unknown>) => layerCommand<Panel>({ ...args, project_id: project }, signal);
    const load = async () => {
      const result = await request({ action: 'open' });
      signal.throwIfAborted();
      if (result.isError || !result._meta?.seedream_layers) throw new Error('LAYER_PROJECT_UNAVAILABLE');
      notify('ui/notifications/tool-result', result);
      setReady(true);
    };
    const timeout = setTimeout(() => { if (!initialized) setError(true); }, 12_000);
    const onMessage = async (event: MessageEvent) => {
      const child = frame.current?.contentWindow;
      if (!child || event.source !== child || event.origin !== 'null' || event.data?.jsonrpc !== '2.0') return;
      const { id, method, params } = event.data;
      const send = (result: unknown) => { if (!signal.aborted) child.postMessage({ jsonrpc: '2.0', id, result }, '*'); };
      const fail = () => { if (!signal.aborted) child.postMessage({ jsonrpc: '2.0', id, error: { code: -32000 } }, '*'); };
      if (method === 'ui/initialize' && typeof id === 'string') {
        send({ protocolVersion: '2026-01-26', hostContext: { locale: currentLanguage.current } });
        return;
      }
      if (method === 'ui/notifications/initialized' && !initialized) {
        initialized = true;
        void load().catch(() => { if (!signal.aborted) setError(true); });
        return;
      }
      if (!initialized || typeof id !== 'string') return;
      try {
        if (method === 'tools/call') {
          const args = params?.arguments;
          if (args?.project_id !== project) { fail(); return; }
          if (params.name === 'seedream_layer_project' && ['open', 'restore'].includes(args.action)) {
            send(await request({ action: args.action, revision: args.revision, expected_revision: args.expected_revision, source_revision: args.source_revision }));
          } else if (params.name === 'seedream_layer_edit') {
            send(await request({ action: 'edit', expected_revision: args.expected_revision, changes: args.changes }));
          } else if (params.name === 'seedream_layer_export') {
            const result = await request({ action: 'export', revision: args.revision, format: args.format, layer_id: args.layer_id });
            const path = result.structuredContent?.path;
            if (path) downloads.add(path);
            send(result);
          } else fail();
        } else if (method === 'seedream/upload') {
          const uploaded = await uploadLayerImage(params?.file, signal);
          send({ path: uploaded.path });
        } else if (method === 'seedream/download') {
          const path = typeof params?.path === 'string' && personalFilePath(params.path);
          if (!path || !downloads.has(path)) { fail(); return; }
          const anchor = document.createElement('a');
          anchor.href = '/api/web/v1/files/view?' + new URLSearchParams({ path, owner, download: '1' });
          anchor.download = path.split('/').at(-1) ?? '';
          document.body.append(anchor);
          try { anchor.click(); } finally { anchor.remove(); }
          send({});
        } else fail();
      } catch { fail(); }
    };
    window.addEventListener('message', onMessage);
    return () => { controller.abort(); clearTimeout(timeout); window.removeEventListener('message', onMessage); };
  }, [project, owner, reload]);

  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { locale: language } }, '*');
  }, [language]);

  return <div className="layer-editor-host">
    <div className="layer-editor-status">
      <button type="button" onClick={back}>{t('web.layersBack')}</button>
      {!ready && !error && <span role="status">{t('common.loading')}</span>}
      {error && <><span role="alert">{t('web.layersUnavailable')}</span><button type="button" onClick={() => {
        setError(false); setReady(false); setReload(value => value + 1);
      }}>{t('common.retry')}</button></>}
    </div>
    <iframe key={reload} ref={frame} src={endpoint} title={t('web.layersEditor')} sandbox="allow-scripts" referrerPolicy="no-referrer"/>
  </div>;
}
