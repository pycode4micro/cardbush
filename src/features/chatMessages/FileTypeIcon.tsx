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
  Settings2,
  Package,
  Box,
  Type,
  LockKeyhole,
  SquareTerminal,
} from 'lucide-react';

import { resourceBasename } from '../../shared/localPaths';
import { codeLanguageForPath } from '../../shared/codeLanguages';

type FileTypeDescriptor =
  | { kind: 'badge'; label: string; tone: string }
  | { kind: 'react'; tone: string }
  | { kind: 'icon'; icon: typeof FileCode2; tone: string };

const badgeTypes: Record<string, { label: string; tone: string }> = {
  typescript: { label: 'TS', tone: 'typescript' },
  javascript: { label: 'JS', tone: 'javascript' },
  python: { label: 'PY', tone: 'python' },
  go: { label: 'GO', tone: 'go' },
  rust: { label: 'RS', tone: 'rust' },
  ruby: { label: 'RB', tone: 'ruby' },
  php: { label: 'PHP', tone: 'php' },
  java: { label: 'JV', tone: 'java' },
  kotlin: { label: 'KT', tone: 'kotlin' },
  swift: { label: 'SW', tone: 'swift' },
  vue: { label: 'V', tone: 'vue' },
  svelte: { label: 'S', tone: 'svelte' },
  c: { label: 'C', tone: 'c' },
  cpp: { label: 'C++', tone: 'cpp' },
  csharp: { label: 'C#', tone: 'csharp' },
  fsharp: { label: 'F#', tone: 'fsharp' },
  vbnet: { label: 'VB', tone: 'vbnet' },
  objectivec: { label: 'OC', tone: 'c' },
  dart: { label: 'D', tone: 'dart' },
  lua: { label: 'LUA', tone: 'lua' },
  r: { label: 'R', tone: 'r' },
  scala: { label: 'SC', tone: 'ruby' },
  groovy: { label: 'GR', tone: 'go' },
  perl: { label: 'PL', tone: 'python' },
  clojure: { label: 'CLJ', tone: 'vue' },
  elixir: { label: 'EX', tone: 'csharp' },
  erlang: { label: 'ERL', tone: 'ruby' },
  haskell: { label: 'HS', tone: 'fsharp' },
  julia: { label: 'JL', tone: 'csharp' },
  zig: { label: 'Z', tone: 'rust' },
  wasm: { label: 'WA', tone: 'fsharp' },
  graphql: { label: 'GQL', tone: 'graphql' },
  protobuf: { label: 'PB', tone: 'go' },
  latex: { label: 'TeX', tone: 'vue' },
};

export function fileTypeDescriptor(path: string, mediaType?: 'image' | 'video' | 'audio'): FileTypeDescriptor {
  const filename = resourceBasename(path).toLowerCase();
  const extension = filename.match(/\.([^.]+)$/)?.[1] ?? '';
  const language = codeLanguageForPath(path)?.id ?? '';
  if (extension === 'tsx' || extension === 'jsx') {
    return { kind: 'react', tone: extension === 'tsx' ? 'typescript-react' : 'javascript-react' };
  }
  const badge = badgeTypes[language];
  if (badge) return { kind: 'badge', ...badge };
  if (/^(?:json|jsonc|json5)$/.test(language)) return { kind: 'icon', icon: Braces, tone: 'json' };
  if (/^(?:yaml|toml|ini|hcl|nginx|cmake|makefile)$/.test(language) ||
    /^(?:conf|config|sln|slnx|csproj|fsproj|vbproj|props|targets|lock)$/.test(extension) ||
    /^\.(?:gitignore|gitattributes|dockerignore|prettierignore|browserslistrc|eslintrc|prettierrc)$/.test(filename)) {
    return { kind: 'icon', icon: Settings2, tone: 'config' };
  }
  if (language === 'docker' || /^(?:exe|msi|msix|appx|appxbundle|msixbundle|appimage|deb|rpm|dmg|pkg|apk|aab|jar|dll|so|dylib|wasm)$/.test(extension)) return { kind: 'icon', icon: Package, tone: 'package' };
  if (/^(?:css|scss|sass|less)$/.test(language)) return { kind: 'icon', icon: Hash, tone: 'styles' };
  if (/^(?:bash|powershell|batch)$/.test(language) || extension === 'fish') return { kind: 'icon', icon: SquareTerminal, tone: 'terminal' };
  if (/^(?:sql|db|sqlite|sqlite3|db3|parquet|arrow|feather)$/.test(extension)) return { kind: 'icon', icon: Database, tone: 'database' };
  if (/^(?:png|apng|avif|jpe?g|gif|webp|svg|bmp|ico|tiff?|heic|heif|psd|ai|eps)$/.test(extension)) return { kind: 'icon', icon: FileImage, tone: 'image' };
  if (language === 'markup') return { kind: 'icon', icon: CodeXml, tone: 'markup' };
  if (/^(?:mp4|m4v|mov|webm|ogv|mkv|avi|mpeg|mpg|wmv|flv)$/.test(extension)) return { kind: 'icon', icon: FileVideo, tone: 'video' };
  if (/^(?:mp3|m4a|aac|wav|ogg|oga|opus|flac|aiff?|wma|mid|midi)$/.test(extension)) return { kind: 'icon', icon: FileAudio, tone: 'audio' };
  if (/^(?:xls|xlsx|xlsm|xlsb|xltx|csv|tsv|ods|numbers)$/.test(extension)) return { kind: 'icon', icon: FileSpreadsheet, tone: 'sheet' };
  if (/^(?:ppt|pptx|pptm|potx|pps|ppsx|odp|key)$/.test(extension)) return { kind: 'icon', icon: Presentation, tone: 'slides' };
  if (/^(?:zip|rar|7z|tar|gz|tgz|bz2|tbz2|xz|txz|zst|br|cab|iso)$/.test(extension)) return { kind: 'icon', icon: FileArchive, tone: 'archive' };
  if (/^(?:ttf|otf|woff|woff2|eot)$/.test(extension)) return { kind: 'icon', icon: Type, tone: 'font' };
  if (/^(?:pem|crt|cer|pfx|p12|key|pub)$/.test(extension)) return { kind: 'icon', icon: LockKeyhole, tone: 'certificate' };
  if (/^(?:blend|gltf|glb|obj|fbx|stl|usd|usdz|step|stp)$/.test(extension)) return { kind: 'icon', icon: Box, tone: 'model' };
  if (/^(?:md|markdown|mdx|txt|text|log|rtf|pdf|doc|docx|docm|odt|pages|epub|rst|adoc|ics|eml|msg)$/.test(extension) ||
    /^(?:readme|licen[sc]e|notice|changelog|authors|copying)(?:\.|$)/.test(filename)) return { kind: 'icon', icon: FileText, tone: 'document' };
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
