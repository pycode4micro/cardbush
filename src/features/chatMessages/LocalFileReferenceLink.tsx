import { FolderOpen, Play } from 'lucide-react';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

import { basename, fileUrl } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
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
  knownFileName,
}: {
  path: string;
  children?: ReactNode;
  unavailableLabel?: ReactNode;
  /** A caller that just resolved a native file can reuse that observation. */
  knownFileName?: string;
}) {
  const [inspection, setInspection] = useState<LocalReferenceInspection | null>(null);
  const inspectionComplete = knownFileName !== undefined || inspection?.path === path;
  const metadata = knownFileName !== undefined ? { path, name: knownFileName, kind: 'file' as const }
    : inspection?.path === path ? inspection.metadata : null;
  const directoryLike = metadata?.kind === 'folder';
  const applicationLike = metadata?.kind === 'application';
  const pathLabel = basename(path);
  const childrenMatchPath = typeof children === 'string' && children.trim() === pathLabel;
  const label = applicationLike && metadata?.name && (!children || childrenMatchPath)
    ? metadata.name
    : children || metadata?.name || pathLabel;

  useEffect(() => {
    if (knownFileName !== undefined) return;
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
  }, [path, knownFileName]);

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
    openFileContextMenu(event, path);
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
