import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { PageHistory } from './pageHistory';

type History = Pick<PageHistory<unknown>, 'read' | 'update' | 'subscribe' | 'getRevision' | 'back' | 'forward' | 'canGoBack' | 'canGoForward'>;
export const PageNavigationContext = createContext<History | undefined>(undefined);
export const PageNavigationScope = createContext('main');
export function usePageNavigation<Route>(route: Route, restore: (route: Route) => void, available: (route: Route) => boolean = () => true) {
  const [history] = useState(() => new PageHistory(route, restore, available));
  history.configure(restore, available);
  useSyncExternalStore(history.subscribe, history.getRevision, history.getRevision);
  useLayoutEffect(() => { history.observe(route); });
  return history;
}

/** Track navigation selections, never drafts, credentials or execution state. */
export function usePageState<T>(name: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const history = useContext(PageNavigationContext), scope = useContext(PageNavigationScope);
  const [local, setLocal] = useState(initial), fallback = useRef(local), key = `${scope}:${name}`;
  const read = useCallback(() => history ? history.read(key, fallback.current) : local, [history, key, local]);
  const subscribe = useCallback((listener: () => void) => history?.subscribe(listener) ?? (() => {}), [history]);
  const value = useSyncExternalStore(subscribe, read, read);
  const set = useCallback<Dispatch<SetStateAction<T>>>(update => {
    if (history) history.update(key, fallback.current, update); else setLocal(update);
  }, [history, key]);
  return [value, set];
}

export function usePageBack(fallback: () => void) {
  const history = useContext(PageNavigationContext);
  return () => history?.canGoBack ? history.back() : fallback();
}
