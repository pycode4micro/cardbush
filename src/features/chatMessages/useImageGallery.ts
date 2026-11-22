import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatMessage, ChatToolExecution } from '../../types';
import { fetchRuntimeTurnToolExecutionDetails } from '../../backend/api';
import { ImageGalleryContext } from './ImageGalleryContext';
import { ConversationHostContext } from '../conversationHost';
import { appendGalleryImages, galleryImage, galleryImageKey, imageDirectory, sessionGalleryImages,
  type ImageGalleryScope, type ImagePreviewSource } from './imageGallery';
const emptyMessages: ChatMessage[] = [];
const readEmpty = () => emptyMessages;
const subscribeEmpty = () => () => {};

export function useImageGallery(initial: ImagePreviewSource, options: {
  images?: ImagePreviewSource[];
  initialScope?: ImageGalleryScope;
  onClose: () => void;
}) {
  const context = useContext(ImageGalleryContext);
  const host = useContext(ConversationHostContext);
  const messages = useSyncExternalStore(context?.subscribe ?? subscribeEmpty, context?.read ?? readEmpty, readEmpty);
  const sessionId = context?.sessionId;
  const openedSession = useRef(sessionId);
  const directory = imageDirectory(initial);
  const workspace = context?.workspaceRoot ?? '';
  const canScan = !host && Boolean(window.cardbushDesktop?.startImageGallery);
  const requestedScope = options.initialScope ?? (options.images ? 'attachments' : context ? 'session' : canScan && directory ? 'directory' : 'session');
  const defaultScope = (requestedScope === 'directory' && (!canScan || !directory)) || (requestedScope === 'workspace' && (!canScan || !workspace))
    ? 'session' : requestedScope;
  const [scope, setScope] = useState<ImageGalleryScope>(defaultScope);
  const [details, setDetails] = useState<{ sessionId: string | undefined; turns: Map<string, ChatToolExecution[]> }>();
  const detailTurns = details?.sessionId === sessionId ? details?.turns : undefined;
  const toolDetails = host?.toolDetails ?? ((sessionId: string, turnId: string) => fetchRuntimeTurnToolExecutionDetails({ sessionId, turnId }));
  const isToolGallery = options.initialScope === 'session' && Boolean(options.images);
  const deferred = useMemo(() => {
    if (!isToolGallery || scope !== 'session') return '';
    const turns = new Set<string>();
    const visit = (message: ChatMessage) => {
      message.loopHistory?.forEach(visit);
      if (!message.conversationId) return;
      for (const execution of message.toolExecutions ?? []) {
        const turnId = execution.turnId ?? message.turnId;
        if (turnId && execution.metadata.nativeResultDeferred === true && ['inject_image_input', 'view_image'].includes(execution.name)) {
          turns.add(JSON.stringify([message.conversationId, turnId]));
        }
      }
    };
    messages.forEach(visit);
    return [...turns].join('\n');
  }, [messages, isToolGallery, scope]);
  const readDetails = useRef(toolDetails);
  readDetails.current = toolDetails;
  useEffect(() => {
    if (!deferred) return;
    let active = true;
    const read = async () => {
      const turns = new Map(detailTurns);
      for (const key of deferred.split('\n')) {
        if (!active) return;
        if (turns.has(key)) continue;
        const [conversationId, turnId] = JSON.parse(key) as [string, string];
        try { turns.set(key, await readDetails.current(conversationId, turnId)); }
        catch { /* Images already loaded in the transcript remain available. */ }
      }
      if (active) setDetails({ sessionId, turns });
    };
    void read();
    return () => { active = false; };
  }, [deferred, sessionId]);

  const knownImages = useCallback((target: ImageGalleryScope) => {
    const values = target === 'attachments' ? options.images ?? [] : target === 'session' && context
      ? [...sessionGalleryImages(messages, workspace, context.pathAliases, (execution, message) =>
          detailTurns?.get(JSON.stringify([message.conversationId, execution.turnId ?? message.turnId]))?.find(record => record.id === execution.id)),
        ...(isToolGallery ? options.images ?? [] : [])] : [];
    return appendGalleryImages([], [...values, initial]).map(image => galleryImageKey(image) === galleryImageKey(initial) ? initial : image);
  }, [options.images, context, messages, workspace, initial, detailTurns, isToolGallery]);
  const [images, setImages] = useState(() => knownImages(defaultScope));
  const [selected, setSelected] = useState(() => galleryImageKey(initial));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [skipped, setSkipped] = useState(0);
  const [more, setMore] = useState(false);
  const continueScanRef = useRef<(() => void) | null>(null);
  const scanRef = useRef<{ id: string; root: string; scope: ImageGalleryScope } | null>(null);
  const knownRef = useRef(knownImages);
  knownRef.current = knownImages;
  const index = Math.max(0, images.findIndex(image => galleryImageKey(image) === selected));
  const image = images[index] ?? initial;
  const imageRef = useRef(image);
  imageRef.current = image;

  const initialIdentity = `${galleryImageKey(initial)}\n${initial.src}`;
  const lastInitial = useRef(initialIdentity);
  useLayoutEffect(() => {
    if (lastInitial.current === initialIdentity) return;
    lastInitial.current = initialIdentity;
    setImages(knownRef.current(defaultScope));
    setSelected(galleryImageKey(initial));
    setScope(defaultScope);
  }, [initialIdentity, defaultScope, initial]);

  useEffect(() => {
    if (sessionId !== openedSession.current) options.onClose();
  }, [sessionId, options.onClose]);

  useEffect(() => {
    if (scope === 'session' || scope === 'attachments') {
      const known = knownImages(scope);
      setImages(current => isToolGallery && scope === 'session' ? appendGalleryImages(known, current) : appendGalleryImages(current, known));
    }
  }, [scope, knownImages, isToolGallery]);

  useEffect(() => {
    if (!canScan || (scope !== 'directory' && scope !== 'workspace')) return;
    const root = scope === 'directory' ? directory : workspace;
    if (!root) return;
    let cancelled = false;
    let running = false;
    let id = '';
    const bridge = window.cardbushDesktop!;
    setLoading(true); setError(''); setMore(false);
    const scan = async () => {
      if (running || cancelled) return;
      running = true;
      setLoading(true); setMore(false);
      try {
        const existing = scanRef.current;
        let page = existing && existing.root === root && existing.scope === scope
          ? await bridge.nextImageGallery(existing.id)
          : await bridge.startImageGallery(root, scope === 'workspace');
        id = page.id;
        let count = 0;
        while (!cancelled) {
          scanRef.current = { id, root, scope };
          setImages(current => appendGalleryImages(current, page.images.map(entry => galleryImage(entry.path, entry.name))));
          setSkipped(page.skipped);
          count += page.images.length;
          if (page.done) { scanRef.current = null; break; }
          // An unusually large gallery is expanded explicitly, without retaining image bytes.
          if (count >= 2048) { setMore(true); break; }
          await new Promise(resolve => setTimeout(resolve, 16));
          if (cancelled) break;
          page = await bridge.nextImageGallery(id);
        }
      } catch (cause) { if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause)); }
      finally {
        running = false;
        if (cancelled && id) void bridge.closeImageGallery(id).catch(() => undefined);
        if (!cancelled) setLoading(false);
      }
    };
    continueScanRef.current = () => { void scan(); };
    void scan();
    return () => {
      cancelled = true;
      continueScanRef.current = null;
      if (id) void bridge.closeImageGallery(id).catch(() => undefined);
      scanRef.current = null;
    };
  }, [scope, directory, workspace, canScan]);

  const changeScope = (next: ImageGalleryScope) => {
    if (next === scope) return;
    const current = imageRef.current;
    const known = knownRef.current(next);
    setImages(next === 'directory' || next === 'workspace' ? [current] : next === 'attachments' ? known : appendGalleryImages(known, [current]));
    setSelected(next === 'attachments' && !known.some(image => galleryImageKey(image) === galleryImageKey(current))
      ? galleryImageKey(initial) : galleryImageKey(current));
    setError(''); setSkipped(0); setMore(false); setLoading(false);
    setScope(next);
  };
  const move = useCallback((delta: number) => {
    setSelected(current => {
      const position = Math.max(0, images.findIndex(entry => galleryImageKey(entry) === current));
      return galleryImageKey(images[Math.max(0, Math.min(images.length - 1, position + delta))] ?? initial);
    });
  }, [images, initial]);
  const scopes: ImageGalleryScope[] = context && (!options.images || isToolGallery) ? ['session'] : [];
  if (options.images) scopes.push('attachments');
  if (canScan && directory) scopes.push('directory');
  if (canScan && workspace) scopes.push('workspace');
  return { image, images, index, scope, scopes, changeScope, move, loading, error, skipped, more,
    loadMore: () => continueScanRef.current?.(), retry: () => {
      scanRef.current = null;
      setError('');
      continueScanRef.current?.();
    } };
}
