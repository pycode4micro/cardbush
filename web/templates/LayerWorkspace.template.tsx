import type { FormEvent, ReactNode, RefObject } from 'react';
import { RotateCw, X } from 'lucide-react';
import { uiText } from '../../src/i18n';
import { useUiLanguage } from '../../src/i18n/react';

type Props = {
  dialog: RefObject<HTMLDialogElement | null>; close: () => void; error: string; busy: string; file: File | null;
  setFile: (file: File | null) => void; prompt: string; setPrompt: (value: string) => void; maxImages: string;
  setMaxImages: (value: string) => void; size: string; setSize: (value: string) => void; create: (event: FormEvent) => void;
  projects: Array<{ id: string; title: string; revision: number }>;
  tasks: Array<{ id: string; title: string; label: string; clickable: boolean }>;
  loaded: boolean; reload: () => void; open: (id: string) => void; watch: (id: string) => void; editor: ReactNode;
};

export function LayerWorkspaceView(props: Props) {
  const t = uiText(useUiLanguage());
  return <dialog ref={props.dialog} className="layer-workspace" aria-labelledby="layer-workspace-title"
    onCancel={event => { event.preventDefault(); props.close(); }}>
    <header>
      <h2 id="layer-workspace-title">{t('web.layersEditor')}</h2>
      <button className="icon-button" type="button" aria-label={t('mcpAppPanel.closeInterface')} onClick={props.close}><X aria-hidden="true"/></button>
    </header>
    {props.editor ?? <div className="layer-dashboard">
      <form onSubmit={props.create}>
        <h3>{t('web.layersNewProject')}</h3>
        <fieldset disabled={Boolean(props.busy)}>
          <label>{t('web.layersChooseImage')}<input required type="file" accept=".png,.jpg,.jpeg,.webp"
            onChange={event => props.setFile(event.currentTarget.files?.[0] ?? null)}/></label>
          <label>{t('web.layersInstructions')}<textarea required rows={3} maxLength={2000} value={props.prompt}
            onChange={event => props.setPrompt(event.currentTarget.value)}/></label>
          <div className="layer-parameters">
            <label>{t('web.layersMaxImages')}<input type="number" min={2} max={100} required value={props.maxImages}
              onChange={event => props.setMaxImages(event.currentTarget.value)}/></label>
            <label>{t('web.layersResolution')}<select value={props.size}
              onChange={event => props.setSize(event.currentTarget.value)}>
              {['1K', '1.5K', '2K'].map(size => <option key={size}>{size}</option>)}
            </select></label>
          </div>
          <button className="primary" disabled={!props.file || !props.prompt.trim()} type="submit">{t('web.layersSubmit')}</button>
        </fieldset>
        <p className="layer-hint">{t('web.layersCost')}</p>
        {props.busy && <p role="status">{props.busy}</p>}
        {props.error && <p className="form-error" role="alert">{props.error}</p>}
      </form>
      <section aria-labelledby="layer-projects-title">
        <div className="layer-heading">
          <h3 id="layer-projects-title">{t('web.layersProjects')}</h3>
          <button className="icon-button" type="button" aria-label={t('mcpAppPanel.reload')} onClick={props.reload}><RotateCw aria-hidden="true"/></button>
        </div>
        {props.tasks.length > 0 && <ul className="layer-task-list">
          {props.tasks.map(task => <li key={task.id}>{task.clickable
            ? <button type="button" disabled={Boolean(props.busy)} onClick={() => props.watch(task.id)}><span>{task.title}</span><span>{task.label}</span></button>
            : <p>{task.title} · {task.label}</p>}</li>)}
        </ul>}
        {!props.loaded && !props.error && <p role="status">{t('common.loading')}</p>}
        {props.loaded && !props.projects.length && !props.tasks.length && <p>{t('web.layersEmpty')}</p>}
        <ul className="layer-project-list">{props.projects.map(project => <li key={project.id}>
          <button type="button" disabled={Boolean(props.busy)} onClick={() => props.open(project.id)}><span>{project.title}</span>
            <small>{t('web.layersRevision', { revision: project.revision })}</small></button>
        </li>)}</ul>
      </section>
    </div>}
  </dialog>;
}
