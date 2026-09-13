import {
  Braces,
  CodeXml,
  Database,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Hash,
  Presentation,
  SquareTerminal,
} from 'lucide-react';

import { resourceBasename } from '../../shared/localPaths';

type FileTypeDescriptor =
  | { kind: 'badge'; label: string; tone: string }
  | { kind: 'react'; tone: string }
  | { kind: 'icon'; icon: typeof FileCode2; tone: string };

const badgeTypes: Record<string, { label: string; tone: string }> = {
  ts: { label: 'TS', tone: 'typescript' },
  js: { label: 'JS', tone: 'javascript' },
  py: { label: 'PY', tone: 'python' },
  go: { label: 'GO', tone: 'go' },
  rs: { label: 'RS', tone: 'rust' },
  rb: { label: 'RB', tone: 'ruby' },
  php: { label: 'PHP', tone: 'php' },
  java: { label: 'JV', tone: 'java' },
  kt: { label: 'KT', tone: 'kotlin' },
  swift: { label: 'SW', tone: 'swift' },
  vue: { label: 'V', tone: 'vue' },
  svelte: { label: 'S', tone: 'svelte' },
};

export function fileTypeDescriptor(path: string, mediaType?: 'image' | 'video' | 'audio'): FileTypeDescriptor {
  const extension = resourceBasename(path).match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? '';
  if (extension === 'tsx' || extension === 'jsx') {
    return { kind: 'react', tone: extension === 'tsx' ? 'typescript-react' : 'javascript-react' };
  }
  const badge = badgeTypes[extension];
  if (badge) return { kind: 'badge', ...badge };
  if (/^(?:json|jsonc)$/.test(extension)) return { kind: 'icon', icon: Braces, tone: 'json' };
  if (/^(?:html?|xhtml|xml)$/.test(extension)) return { kind: 'icon', icon: CodeXml, tone: 'markup' };
  if (/^(?:css|scss|sass|less)$/.test(extension)) return { kind: 'icon', icon: Hash, tone: 'styles' };
  if (/^(?:sh|bash|zsh|fish|ps1|bat|cmd)$/.test(extension)) return { kind: 'icon', icon: SquareTerminal, tone: 'terminal' };
  if (/^(?:sql|db|sqlite|sqlite3)$/.test(extension)) return { kind: 'icon', icon: Database, tone: 'database' };
  if (/^(?:png|apng|avif|jpe?g|gif|webp|svg|bmp|ico)$/.test(extension)) return { kind: 'icon', icon: FileImage, tone: 'image' };
  if (/^(?:mp4|m4v|mov|webm|ogv|mkv|avi|mpeg|mpg)$/.test(extension)) return { kind: 'icon', icon: FileVideo, tone: 'video' };
  if (/^(?:mp3|m4a|aac|wav|ogg|oga|opus|flac|aiff?|wma)$/.test(extension)) return { kind: 'icon', icon: FileAudio, tone: 'audio' };
  if (/^(?:xls|xlsx|xlsm|csv|tsv|ods)$/.test(extension)) return { kind: 'icon', icon: FileSpreadsheet, tone: 'sheet' };
  if (/^(?:ppt|pptx|pps|ppsx|odp|key)$/.test(extension)) return { kind: 'icon', icon: Presentation, tone: 'slides' };
  if (/^(?:zip|rar|7z|tar|gz|bz2|xz)$/.test(extension)) return { kind: 'icon', icon: FileArchive, tone: 'archive' };
  if (/^(?:md|markdown|mdx|txt|rtf|pdf|doc|docx|odt)$/.test(extension)) return { kind: 'icon', icon: FileText, tone: 'document' };
  if (mediaType === 'image') return { kind: 'icon', icon: FileImage, tone: 'image' };
  if (mediaType === 'video') return { kind: 'icon', icon: FileVideo, tone: 'video' };
  if (mediaType === 'audio') return { kind: 'icon', icon: FileAudio, tone: 'audio' };
  return { kind: 'icon', icon: FileCode2, tone: 'generic' };
}

export function FileTypeIcon({ path, mediaType, fileName }: { path: string; mediaType?: 'image' | 'video' | 'audio'; fileName?: string }) {
  const pathDescriptor = fileTypeDescriptor(path, mediaType);
  const descriptor = pathDescriptor.tone === 'generic' && fileName ? fileTypeDescriptor(fileName, mediaType) : pathDescriptor;
  if (descriptor.kind === 'badge') {
    return (
      <span
        className={`local-file-type-icon badge ${descriptor.tone}`}
        aria-hidden="true"
      >
        {descriptor.label}
      </span>
    );
  }
  if (descriptor.kind === 'react') {
    return (
      <span
        className={`local-file-type-icon react ${descriptor.tone}`}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" focusable="false">
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          <ellipse cx="12" cy="12" rx="9" ry="3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <ellipse cx="12" cy="12" rx="9" ry="3.5" fill="none" stroke="currentColor" strokeWidth="1.4" transform="rotate(60 12 12)" />
          <ellipse cx="12" cy="12" rx="9" ry="3.5" fill="none" stroke="currentColor" strokeWidth="1.4" transform="rotate(120 12 12)" />
        </svg>
      </span>
    );
  }
  const Icon = descriptor.icon;
  return (
    <span className={`local-file-type-icon ${descriptor.tone}`} aria-hidden="true">
      <Icon size={13} strokeWidth={1.8} />
    </span>
  );
}
