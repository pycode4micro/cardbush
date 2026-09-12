import { useEffect, useRef, useState } from 'react';
import type { RuntimeRendererExtension } from '@cardbush/bush-runtime';
import type { AppLanguage } from '../types';
import { useRuntimeRendererPlugins, useRuntimeDelegationWorkspace, refreshRuntimeRendererPlugins } from './runtimeExtensions';

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
  if (entry?.error) return <div><p role="alert">{entry.error}</p><button type="button" onClick={() => void refreshRuntimeRendererPlugins()}>{language === 'zh' ? '重试' : 'Retry'}</button></div>;
  if (!entry) return <p>{language === 'zh' ? '插件未启用或尚未加载。' : 'Plugin is disabled or not loaded.'}</p>;
  return <>{error && <p role="alert">{error}</p>}<div className="runtime-plugin-surface" ref={container} style={{ display: error ? 'none' : 'contents' }} /></>;
}

/** Historical delegation navigation mounts an installed contribution without importing its implementation. */
export function RuntimeDelegationSurface({ language, slot, ...props }: { language: AppLanguage; slot: 'sidebar' | 'content'; [key: string]: unknown }) {
  const workspace = useRuntimeDelegationWorkspace();
  return workspace.extensionId ? <RuntimePluginWorkspace {...props} id={workspace.extensionId} slot={slot} language={language} /> : null;
}
