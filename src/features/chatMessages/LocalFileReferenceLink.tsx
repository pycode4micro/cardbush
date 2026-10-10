import { FolderOpen, Play } from 'lucide-react';
import { useContext, useEffect, useState, type MouseEvent, type ReactNode } from 'react';

import { basename, fileUrl, resourceTargetKind } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import { openInspector } from '../inspector/inspectorEvents';
import { FileTypeIcon } from './FileTypeIcon';
import { ImagePreviewDialog } from './ImagePreviewDialog';
import { ImageGalleryContext } from './ImageGalleryContext';
import { galleryImage, isGalleryImage } from './imageGallery';
import { recordWindowScrollDiagnostic } from '../chat/windowScrollDiagnostics';

type LocalReferenceMetadata = {
  path: string;
  name: string;
  kind: 'file' | 'folder' | 'application';
  icon?: string;
};

type LocalReferenceCacheEntry = {
  pending: Promise<LocalReferenceMetadata | null>;
  resolved?: { metadata: LocalReferenceMetadata | null };
};

const localReferenceMetadata = new Map<string, LocalReferenceCacheEntry>();

type LocalReferenceInspection = {
  path: string;
  metadata: LocalReferenceMetadata | null;
};

export function LocalFileReferenceLink({
  path,
  children,
  unavailableLabel,
  knownFileName,
  onOpen,
  disabled = false,
  className = '',
  language,
}: {
  path: string;
  children?: ReactNode;
  unavailableLabel?: ReactNode;
  /** A caller that just resolved a native file can reuse that observation. */
  knownFileName?: string;
  /** Resolved references can keep their owning surface's navigation behavior. */
  onOpen?: () => void;
  disabled?: boolean;
  className?: string;
  language?: 'zh' | 'en';
}) {
  const gallery = useContext(ImageGalleryContext);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [inspection, setInspection] = useState<LocalReferenceInspection | null>(null);
  const targetKind = resourceTargetKind(path);
  const fileTarget = targetKind === 'local-file' || targetKind === 'ssh-file';
  const key = path.startsWith('ssh://') ? path : path.toLowerCase();
  // A remounted reference must reuse the result synchronously, without briefly
  // switching back to the full, uninspected path on every history refresh.
  const resolved = inspection?.path === path ? inspection : localReferenceMetadata.get(key)?.resolved;
  const inspectionComplete = knownFileName !== undefined || Boolean(resolved);
  const metadata = knownFileName !== undefined ? { path, name: knownFileName, kind: 'file' as const }
    : resolved?.metadata ?? null;
  const directoryLike = metadata?.kind === 'folder';
  const applicationLike = metadata?.kind === 'application';
  const pathLabel = basename(path);
  const childrenMatchPath = typeof children === 'string' && children.trim() === pathLabel;
  const label = applicationLike && metadata?.name && (!children || childrenMatchPath)
    ? metadata.name
    : children || metadata?.name || pathLabel;

  useEffect(() => {
    if (knownFileName !== undefined || !fileTarget) return;
    let active = true;
    const inspect = window.cardbushDesktop?.inspectLocalReference;
    if (!inspect) {
      setInspection({ path, metadata: null });
      return undefined;
    }
    let cached = localReferenceMetadata.get(key);
    if (cached?.resolved) return;
    if (!cached) {
      recordWindowScrollDiagnostic('file-reference-inspection', { path, stage: 'requested' });
      const entry: LocalReferenceCacheEntry = { pending: inspect(path).catch(() => null) };
      entry.pending = entry.pending.then(metadata => {
        entry.resolved = { metadata };
        recordWindowScrollDiagnostic('file-reference-inspection', { path, stage: 'resolved', kind: metadata?.kind ?? 'unavailable' });
        return metadata;
      });
      cached = entry;
      localReferenceMetadata.set(key, entry);
    }
    void cached.pending.then((value) => {
      if (active) setInspection({ path, metadata: value });
    });
    return () => {
      active = false;
    };
  }, [path, key, knownFileName, fileTarget]);

  if (fileTarget && !inspectionComplete) {
    return (
      <span className="local-file-reference-pending" title={path}>
        <FileTypeIcon path={path} />
        <span>{label}</span>
      </span>
    );
  }

  if (!fileTarget || !inspectionComplete || !metadata) {
    return (
      <span className="local-file-reference-unavailable" title={path}>
        {unavailableLabel ?? children ?? pathLabel}
      </span>
    );
  }

  function openInCardbush(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (disabled) return;
    if (onOpen) { onOpen(); return; }
    if (directoryLike || applicationLike) {
      void window.cardbushDesktop?.openPath?.(path);
      return;
    }
    if (isGalleryImage(path)) { setPreviewOpen(true); return; }
    openInspector(path, basename(path));
  }

  function openContextMenu(event: MouseEvent<HTMLAnchorElement>) {
    openFileContextMenu(event, path, { language });
  }

  return (
    <>
    <a
      className={`local-file-reference${applicationLike ? ' local-application-reference' : ''}${className ? ` ${className}` : ''}`}
      href={fileUrl(path)}
      title={path}
      aria-disabled={disabled || undefined}
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
    {previewOpen && <ImagePreviewDialog image={galleryImage(path)} language={gallery?.language ?? 'zh'} onClose={() => setPreviewOpen(false)} />}
    </>
  );
}
