import { FileCode2, FolderOpen, Play } from 'lucide-react';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

import { basename, fileUrl } from '../../shared/localPaths';
import { openInspector } from '../inspector/inspectorEvents';

type LocalReferenceMetadata = {
  path: string;
  name: string;
  kind: 'file' | 'folder' | 'application';
  icon?: string;
};

const localReferenceMetadata = new Map<string, Promise<LocalReferenceMetadata | null>>();

export function LocalFileReferenceLink({
  path,
  children,
}: {
  path: string;
  children?: ReactNode;
}) {
  const [metadata, setMetadata] = useState<LocalReferenceMetadata | null>(null);
  const fallbackDirectoryLike = localReferenceLooksLikeDirectory(path);
  const directoryLike = metadata?.kind === 'folder' || (
    metadata == null && fallbackDirectoryLike
  );
  const applicationLike = metadata?.kind === 'application' || (
    metadata == null && path.toLowerCase().endsWith('.lnk')
  );
  const pathLabel = basename(path);
  const childrenMatchPath = typeof children === 'string' && children.trim() === pathLabel;
  const label = applicationLike && metadata?.name && (!children || childrenMatchPath)
    ? metadata.name
    : children || metadata?.name || pathLabel;

  useEffect(() => {
    let active = true;
    const inspect = window.cardbushDesktop?.inspectLocalReference;
    if (!inspect) return undefined;
    const key = path.toLowerCase();
    let pending = localReferenceMetadata.get(key);
    if (!pending) {
      pending = inspect(path).catch(() => null);
      localReferenceMetadata.set(key, pending);
    }
    void pending.then((value) => {
      if (active) setMetadata(value);
    });
    return () => {
      active = false;
    };
  }, [path]);

  function openInCardbush(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (directoryLike || applicationLike) {
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
      className={`local-file-reference${applicationLike ? ' local-application-reference' : ''}`}
      href={fileUrl(path)}
      title={path}
      onClick={openInCardbush}
      onContextMenu={openContextMenu}
    >
      {applicationLike && metadata?.icon
        ? <img src={metadata.icon} alt="" aria-hidden="true" />
        : applicationLike
          ? <Play size={12} aria-hidden="true" />
          : directoryLike
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
