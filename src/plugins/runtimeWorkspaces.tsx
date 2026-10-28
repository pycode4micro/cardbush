import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import type { RuntimeRendererExtension } from '@cardbush/bush-runtime';
import type { AppLanguage } from '../types';
import { useRuntimeRendererPlugins, refreshRuntimeRendererPlugins } from './runtimeExtensions';

export function RuntimePluginWorkspace({ id, language, slot = 'workspace', ...props }: { id: string; language: AppLanguage; slot?: 'workspace' | 'sidebar' | 'content'; [key: string]: unknown }) {
  const plugins = useRuntimeRendererPlugins();
  const entry = plugins.find(plugin => plugin.id === id);
  const container = useRef<HTMLDivElement>(null);
  const mounted = useRef<ReturnType<RuntimeRendererExtension<HTMLElement>['mount']> | null>(null);
  const [error, setError] = useState('');
  const currentProps = useRef({ ...props, language });
  currentProps.current = { ...props, language };
  useEffect(() => {
    if (!entry?.extension || !container.current) return;
    setError('');
    try { mounted.current = entry.extension.mount(container.current, slot, currentProps.current); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    return () => { try { mounted.current?.dispose(); } catch (error) { console.warn('Plugin view cleanup failed', error); } mounted.current = null; };
  }, [entry?.extension, slot]);
  useEffect(() => { try { mounted.current?.update(currentProps.current); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } });
  if (entry?.error) return <div><p role="alert">{entry.error}</p><button type="button" onClick={() => void refreshRuntimeRendererPlugins()}>{uiText(language)('common.retry')}</button></div>;
  if (!entry) return <p>{uiText(language)('runtimeWorkspaces.pluginIsDisabledOrNotLoaded')}</p>;
  return <>{error && <p role="alert">{error}</p>}<div className="runtime-plugin-surface" ref={container} hidden={Boolean(error)} /></>;
}
