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
              {language === 'zh' ? '重命名项目' : 'Rename project'}
            </strong>
            <span>{language === 'zh' ? '可同时重命名真实项目文件夹' : 'You can also rename the real project folder'}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            title={language === 'zh' ? '关闭' : 'Close'}
            aria-label={language === 'zh' ? '关闭重命名' : 'Close rename dialog'}
          >
            <X size={15} />
          </button>
        </header>
        <label>
          <span>{language === 'zh' ? '项目名称' : 'Project name'}</span>
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
              {language === 'zh' ? '项目名称不能为空' : 'Project name cannot be empty'}
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
            {language === 'zh'
              ? '同时重命名项目文件夹（同一父目录）'
              : 'Also rename the project folder (same parent directory)'}
          </span>
        </label>
        {error ? <p className="project-rename-error" role="alert">{error}</p> : null}
        <footer>
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            {language === 'zh' ? '取消' : 'Cancel'}
          </button>
          <button type="submit" className="primary-button" disabled={!title.trim() || busy}>
            {busy
              ? language === 'zh' ? '处理中…' : 'Renaming…'
              : language === 'zh' ? '重命名' : 'Rename'}
          </button>
        </footer>
      </form>
    </div>
  );
}