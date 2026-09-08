import { useEffect, useState } from 'react';
import { File } from 'lucide-react';
import { basename } from '../../shared/localPaths';
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
  useEffect(() => { onLoadingChange?.(false); }, [path, onLoadingChange]);

  const openExternally = async () => {
    setOpening(true);
    try {
      const open = window.cardbushDesktop?.openPath;
      if (!open) throw new Error(language === 'zh' ? '当前环境无法打开本地文件。' : 'Opening local files is unavailable.');
      const error = await open(path);
      if (error) throw new Error(error);
    } catch (error) {
      await showUiError(language === 'zh' ? '无法打开文件' : 'Unable to open file', `${path}\n\n${String(error)}`);
    } finally {
      setOpening(false);
    }
  };

  return <section className="inspector-file-fallback" aria-label={language === 'zh' ? '文件预览' : 'File preview'}>
    <File size={36} strokeWidth={1.25} aria-hidden="true" />
    <strong className="inspector-file-fallback-name">{basename(path)}</strong>
    <div className="inspector-file-fallback-path">{path}</div>
    <div role={message ? 'alert' : undefined}>
      <p>{message || (language === 'zh' ? '此文件格式暂不支持内置预览。' : 'No built-in preview is available for this file format.')}</p>
    </div>
    <button className="inspector-open-external" type="button" disabled={opening} onClick={() => void openExternally()}>
      {language === 'zh' ? '用系统默认应用打开' : 'Open in default application'}
    </button>
  </section>;
}
