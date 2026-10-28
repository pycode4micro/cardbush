import { uiText } from '../../i18n';
import { useEffect, useState } from 'react';
import { File } from 'lucide-react';
import { basename, resourceTargetKind } from '../../shared/localPaths';
import { showUiError } from '../../shared/showUiError';
import type { AppLanguage } from '../../types';

/** Unknown formats are a normal display state; no content read or external launch on mount. */
export function FilePreviewFallback({ path, language, message, onLoadingChange }: {
  path: string;
  language: AppLanguage;
  message?: string;
  onLoadingChange?: (loading: boolean) => void;
}) {
  const [opening, setOpening] = useState(false);
  const resourceKind = resourceTargetKind(path);
  const fileTarget = resourceKind === 'local-file' || resourceKind === 'ssh-file';
  useEffect(() => { onLoadingChange?.(false); }, [path, onLoadingChange]);

  const openExternally = async () => {
    if (!fileTarget) return;
    setOpening(true);
    try {
      const open = window.cardbushDesktop?.openPath;
      if (!open) throw new Error(uiText(language)('filePreviewFallback.openingLocalFilesIsUnavailable'));
      const error = await open(path);
      if (error) throw new Error(error);
    } catch (error) {
      await showUiError(uiText(language)('filePreviewFallback.unableToOpenFile'), `${path}\n\n${String(error)}`);
    } finally {
      setOpening(false);
    }
  };

  return <section className="inspector-file-fallback" aria-label={uiText(language)('filePreviewFallback.filePreview')}>
    <File size={36} strokeWidth={1.25} aria-hidden="true" />
    <strong className="inspector-file-fallback-name">{basename(path)}</strong>
    <div className="inspector-file-fallback-path">{path}</div>
    <div role={message ? 'alert' : undefined}>
      <p>{!fileTarget ? (uiText(language)('filePreviewFallback.resourceAddressUnavailable'))
        : message || (uiText(language)('filePreviewFallback.noBuiltInPreviewIsAvailableFor'))}</p>
    </div>
    {fileTarget && <button className="inspector-open-external" type="button" disabled={opening} onClick={() => void openExternally()}>
      {uiText(language)('filePreviewFallback.openInDefaultApplication')}
    </button>}
  </section>;
}
