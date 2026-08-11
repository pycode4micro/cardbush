import { FileCode2 } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';

import { basename } from '../../shared/localPaths';

export function LocalFileReferenceLink({
  path,
  children,
}: {
  path: string;
  children?: ReactNode;
}) {
  const label = children || basename(path);

  function openInCardbush(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    void (
      window.cardbushDesktop?.openFileInCardbush ??
      window.cardbushDesktop?.openUiPreview
    )?.(path);
  }

  function openContextMenu(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    event.stopPropagation();
    void window.cardbushDesktop?.showFileContextMenu?.(path);
  }

  return (
    <a
      className="local-file-reference"
      href="#"
      title={path}
      onClick={openInCardbush}
      onContextMenu={openContextMenu}
    >
      <FileCode2 size={12} aria-hidden="true" />
      <span>{label}</span>
    </a>
  );
}
