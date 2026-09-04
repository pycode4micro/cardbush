import { FolderOpen, Play } from 'lucide-react';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

import { basename, fileUrl } from '../../shared/localPaths';
import { openInspector } from '../inspector/inspectorEvents';
import { FileTypeIcon } from './FileTypeIcon';

type LocalReferenceMetadata = {
  path: string;
  name: string;
  kind: 'file' | 'folder' | 'application';
  icon?: string;
};

const localReferenceMetadata = new Map<string, Promise<LocalReferenceMetadata | null>>();

type LocalReferenceInspection = {
  path: string;
  metadata: LocalReferenceMetadata | null;
};

export function LocalFileReferenceLink({
  path,
  children,
  unavailableLabel,
}: {
  path: string;
  children?: ReactNode;
  unavailableLabel?: ReactNode;
}) {
  const [inspection, setInspection] = useState<LocalReferenceInspection | null>(null);
  const inspectionComplete = inspection?.path === path;
  const metadata = inspectionComplete ? inspection.metadata : null;
  const directoryLike = metadata?.kind === 'folder';
  const applicationLike = metadata?.kind === 'application';
  const pathLabel = basename(path);
  const childrenMatchPath = typeof children === 'string' && children.trim() === pathLabel;
  const label = applicationLike && metadata?.name && (!children || childrenMatchPath)
    ? metadata.name
    : children || metadata?.name || pathLabel;

  useEffect(() => {
    let active = true;
    const inspect = window.cardbushDesktop?.inspectLocalReference;
    if (!inspect) {
      setInspection({ path, metadata: null });
      return undefined;
    }
    const key = path.toLowerCase();
    let pending = localReferenceMetadata.get(key);
    if (!pending) {
      pending = inspect(path).catch(() => null);
      localReferenceMetadata.set(key, pending);
    }
    void pending.then((value) => {
      if (active) setInspection({ path, metadata: value });
    });
    return () => {
      active = false;
    };
  }, [path]);

  if (!inspectionComplete || !metadata) {
    return (
      <span className="local-file-reference-unavailable" title={path}>
        {unavailableLabel ?? children ?? pathLabel}
      </span>
    );
  }

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
            : <FileTypeIcon path={path} />}
      <span>{label}</span>
    </a>
  );
}
