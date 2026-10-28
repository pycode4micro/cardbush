import { uiText } from '../../i18n';
import { Folder, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { basename } from '../../shared/localPaths';
import { type AppLanguage, type ProjectItem } from '../../types';

export function ProjectRenameDialog({
  language,
  project,
  onClose,
  onRename,
}: {
  language: AppLanguage;
  project: ProjectItem;
  onClose: () => void;
  onRename: (title: string, renameFolder: boolean) => Promise<string | null>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const [title, setTitle] = useState(project.title);
  const [renameFolder, setRenameFolder] = useState(
    () => project.title.trim() === basename(project.rootPath),
  );
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    const closeWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', closeWithKeyboard);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', closeWithKeyboard);
    };
  }, []);

  const submit = async () => {
    const nextTitle = title.trim();
    if (!nextTitle) {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }
    if (
      nextTitle === project.title.trim() &&
      (!renameFolder || nextTitle === basename(project.rootPath))
    ) {
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    const failure = await onRename(nextTitle, renameFolder).catch((caught) =>
      caught instanceof Error ? caught.message : String(caught),
    );
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onClose();
  };

  return (
    <div
      className="modal-backdrop project-rename-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="project-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-rename-title"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header>
          <Folder size={17} aria-hidden="true" />
          <div>
            <strong id="project-rename-title">
              {uiText(language)('chatSidebar.renameProject')}
            </strong>
            <span>{uiText(language)('projectRenameDialog.youCanAlsoRenameTheRealProject')}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            title={uiText(language)('common.close')}
            aria-label={uiText(language)('projectRenameDialog.closeRenameDialog')}
          >
            <X size={15} />
          </button>
        </header>
        <label>
          <span>{uiText(language)('agentDataSettings.projectName')}</span>
          <input
            ref={inputRef}
            value={title}
            maxLength={120}
            disabled={busy}
            aria-invalid={invalid}
            onChange={(event) => {
              setTitle(event.target.value);
              setInvalid(false);
            }}
          />
          {invalid && (
            <small role="alert">
              {uiText(language)('projectRenameDialog.projectNameCannotBeEmpty')}
            </small>
          )}
        </label>
        <div className="project-rename-path" title={project.rootPath}>
          <Folder size={13} aria-hidden="true" />
          <span>{project.rootPath}</span>
        </div>
        <label className="project-rename-folder-option">
          <input
            type="checkbox"
            checked={renameFolder}
            disabled={busy}
            onChange={(event) => {
              setRenameFolder(event.currentTarget.checked);
              setError('');
            }}
          />
          <span>
            {uiText(language)('projectRenameDialog.alsoRenameTheProjectFolderSameParent')}
          </span>
        </label>
        {error ? <p className="project-rename-error" role="alert">{error}</p> : null}
        <footer>
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            {uiText(language)('agentConnectionForm.cancel')}
          </button>
          <button type="submit" className="primary-button" disabled={!title.trim() || busy}>
            {busy
              ? uiText(language)('projectRenameDialog.renaming')
              : uiText(language)('useAssistantActions.rename')}
          </button>
        </footer>
      </form>
    </div>
  );
}