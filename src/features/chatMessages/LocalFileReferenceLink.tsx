import { FileCode2, FolderOpen } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';

import { basename, fileUrl } from '../../shared/localPaths';
import { openInspector } from '../inspector/inspectorEvents';

export function LocalFileReferenceLink({
  path,
  children,
}: {
  path: string;
  children?: ReactNode;
}) {
  const label = children || basename(path);
  const directoryLike = localReferenceLooksLikeDirectory(path);

  function openInCardbush(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (directoryLike) {
      void window.cardbushDesktop?.openPath?.(path);
      return;
    }
    openInspector(path, basename(path));
  }

  function openContextMenu(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    event.stopPropagation();
    void window.cardbushDesktop?.showFileContextMenu?.(path);
  }

  return (
    <a
      className="local-file-reference"
      href={fileUrl(path)}
      title={path}
      onClick={openInCardbush}
      onContextMenu={openContextMenu}
    >
      {directoryLike
        ? <FolderOpen size={12} aria-hidden="true" />
        : <FileCode2 size={12} aria-hidden="true" />}
      <span>{label}</span>
    </a>
  );
}

function localReferenceLooksLikeDirectory(path: string) {
  const name = basename(path);
  if (!name || path.endsWith('/') || path.endsWith('\\')) return true;
  return !/\.[a-z0-9][a-z0-9._-]{0,15}$/i.test(name);
}
