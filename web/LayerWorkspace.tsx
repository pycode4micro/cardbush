import { Layers3 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { uiText } from '../src/i18n';
import { useUiLanguage } from '../src/i18n/react';
import type { Attachment } from './AgentWidgets';
import { api, requestId } from './api';
import { LayerWorkspaceView } from './templates/LayerWorkspace.template';
import { LayerEditorFrame } from './LayerEditorFrame';
import { layerCommand, uploadLayerImage } from './layerService';
import './layerWorkspace.css';

type Project = { id: string; title: string; revision: number };
type Task = { id: string; status: string; title: string };
type ProjectList = { projects: Project[]; tasks: Task[] };
type TaskResult = { task: Task; project_id?: string };

const running = (task: Task) => ['queued', 'running'].includes(task.status);
const outcome = (task: Task, t: ReturnType<typeof uiText>) => (
  task.status === 'succeeded' ? t('web.layersOpenResult')
    : task.status === 'unknown' ? t('web.layersUncertain')
    : task.status === 'interrupted' ? t('web.layersInterrupted')
    : t('web.layersDecomposing')
);

export function LayerWorkspaceControl({ owner }: { owner: string }) {
  const language = useUiLanguage(), t = uiText(language);
  const [enabled, setEnabled] = useState(false), [open, setOpen] = useState(false);
  const launch = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    const check = () => { void api<{ imageEnabled: boolean }>('/plugins', 'GET', undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setEnabled(value.imageEnabled); }).catch(() => {}); };
    check();
    window.addEventListener('focus', check);
    return () => { controller.abort(); window.removeEventListener('focus', check); };
  }, [owner]);
  return <>{enabled && <button className="layer-launch" type="button" ref={launch}
    onClick={() => setOpen(true)}><Layers3 aria-hidden="true"/>{t('web.layersEditor')}</button>}
    {open && <LayerWorkspace owner={owner} close={() => { setOpen(false); launch.current?.focus(); }}/>}
  </>;
}

function LayerWorkspace({ owner, close }: { owner: string; close: () => void }) {
  const t = uiText(useUiLanguage());
  const dialog = useRef<HTMLDialogElement>(null);
  const [project, setProject] = useState<string | null>(null);
  const [listing, setListing] = useState<ProjectList | null>(null);
  const [watching, setWatching] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState(() => t('web.layersDefaultPrompt'));
  const [maxImages, setMaxImages] = useState('8'), [size, setSize] = useState('1K');
  const lifetime = useRef(new AbortController());
  const submission = useRef<{ file: File; attachment: Attachment; key: string; prompt: string; maxImages: string; size: string } | null>(null);
  const errorLabel = useCallback(() => uiText()('web.layersUnavailable'), []);
  useEffect(() => {
    const modal = dialog.current!;
    const controller = new AbortController();
    lifetime.current = controller;
    modal.showModal();
    return () => { controller.abort(); modal.close(); };
  }, []);
  const reload = useCallback(async (signal: AbortSignal) => {
    try {
      const value = await layerCommand<ProjectList>({ action: 'list' }, signal);
      if (value.isError) throw new Error(errorLabel());
      if (!signal.aborted) setListing(value);
    } catch { if (!signal.aborted) setError(errorLabel()); }
  }, [errorLabel]);
  useEffect(() => {
    if (project) return;
    void reload(lifetime.current.signal);
  }, [project, reload]);
  const getResult = useCallback(async (id: string, signal: AbortSignal) => {
    const value = await layerCommand<TaskResult>({ action: 'status', task_id: id }, signal);
    signal.throwIfAborted();
    if (value.isError) {
      setWatching(''); setBusy(''); setError(uiText()('web.layersResultInvalid'));
      return false;
    }
    if (value.project_id) {
      setProject(value.project_id); setWatching(''); setBusy(''); setError('');
      return false;
    }
    if (running(value.task)) {
      setBusy(uiText()('web.layersDecomposing'));
      return true;
    }
    setWatching(''); setBusy('');
    setError(outcome(value.task, uiText()));
    void reload(signal);
    return false;
  }, [reload]);
  useEffect(() => {
    if (!watching) return;
    const signal = lifetime.current.signal;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { if (await getResult(watching, signal)) timer = setTimeout(poll, 2400); }
      catch { if (!signal.aborted) { setWatching(''); setBusy(''); setError(errorLabel()); void reload(signal); } }
    };
    void poll();
    return () => clearTimeout(timer);
  }, [watching, getResult, errorLabel, reload]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!file || busy || !prompt.trim()) return;
    const signal = lifetime.current.signal;
    setError(''); setBusy(t('web.preparingAttachments'));
    try {
      // A lost response can be retried with the same upload and request key.
      if (!submission.current || submission.current.file !== file || submission.current.prompt !== prompt
        || submission.current.maxImages !== maxImages || submission.current.size !== size) {
        const attachment = await uploadLayerImage(file, signal, setBusy);
        submission.current = { file, attachment, key: requestId(), prompt, maxImages, size };
      }
      const { key, attachment } = submission.current;
      setBusy(t('web.layersDecomposing'));
      const reply = await layerCommand<TaskResult>({
        action: 'create', request_id: key, reference_path: attachment.path, prompt, size, max_images: Number(maxImages),
      }, signal);
      signal.throwIfAborted();
      if (reply.isError) throw new Error(errorLabel());
      setWatching(reply.task.id);
      setFile(null); submission.current = null;
    } catch (failure) {
      if (!signal.aborted) {
        setBusy('');
        setError(failure instanceof Error && failure.message === 'LAYER_MODEL_UNAVAILABLE' ? t('web.layersModelUnavailable') : errorLabel());
        void reload(signal);
      }
    }
  }

  return <LayerWorkspaceView dialog={dialog} close={close} error={error} busy={busy} file={file} setFile={setFile}
    prompt={prompt} setPrompt={setPrompt} maxImages={maxImages} setMaxImages={setMaxImages} size={size} setSize={setSize} create={create}
    projects={listing?.projects ?? []} tasks={(listing?.tasks ?? []).map(task => ({ id: task.id, title: task.title, label: outcome(task, t), clickable: running(task) || task.status === 'succeeded' }))}
    loaded={listing !== null} reload={() => { setError(''); void reload(lifetime.current.signal); }}
    open={id => { setError(''); setProject(id); }} watch={id => { setError(''); setBusy(t('web.layersDecomposing')); setWatching(id); }}
    editor={project ? <LayerEditorFrame key={project} project={project} owner={owner} back={() => { setError(''); setProject(null); }} /> : null}/>;
}
