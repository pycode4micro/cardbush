import { basename, fileUrl } from '../../shared/localPaths';
import type { InspectorFilePreviewRenderer } from './inspectorFilePreviewRenderers';

export type FilePreviewAdapter = {
  readonly id: string;
  readonly extensions?: readonly string[];
  readonly fileNames?: readonly string[];
  readonly renderer: InspectorFilePreviewRenderer | 'webview';
  readonly source: (path: string, originalTarget?: string) => string;
};

/** Source-controlled registrations. Duplicate claims fail instead of silently changing a renderer. */
export function createFilePreviewRegistry(adapters: readonly FilePreviewAdapter[]) {
  const extensions = new Map<string, FilePreviewAdapter>();
  const fileNames = new Map<string, FilePreviewAdapter>();
  const ids = new Set<string>();
  const add = (index: Map<string, FilePreviewAdapter>, key: string, adapter: FilePreviewAdapter) => {
    const normalized = key.toLowerCase();
    if (index.has(normalized)) throw new Error(`Duplicate file preview match: ${key}`);
    index.set(normalized, adapter);
  };
  for (const adapter of adapters) {
    if (!adapter.id || ids.has(adapter.id)) throw new Error(`Duplicate or empty file preview id: ${adapter.id}`);
    ids.add(adapter.id);
    for (const extension of adapter.extensions ?? []) {
      if (!/^\.[a-z0-9]+$/i.test(extension)) throw new Error(`Invalid file preview extension: ${extension}`);
      add(extensions, extension, adapter);
    }
    for (const name of adapter.fileNames ?? []) add(fileNames, name, adapter);
  }
  // Callers supply decoded local paths. '#' and '?' can be part of a filename.
  return (path: string): FilePreviewAdapter | null => {
    const name = basename(path).toLowerCase();
    return fileNames.get(name) ?? extensions.get(name.slice(name.lastIndexOf('.'))) ?? null;
  };
}

function textSource(path: string) {
  return `cardbush-file://text-preview/?path=${encodeURIComponent(path)}`;
}

function nativeSource(path: string) {
  if (path.startsWith('\\\\')) {
    const [host, ...parts] = path.slice(2).replaceAll('\\', '/').split('/');
    return `file://${host}/${parts.map(encodeURIComponent).join('/')}`;
  }
  if (!/^[a-zA-Z]:[\\/]/.test(path)) return fileUrl(path);
  const encoded = path.replaceAll('\\', '/').split('/')
    .map((part, index) => index === 0 ? part : encodeURIComponent(part)).join('/');
  return `file:///${encoded}`;
}

// Maintenance entry point: register a format only when its renderer exists.
// New renderer components belong in inspectorFilePreviewRenderers.tsx.
export const filePreviewAdapters: readonly FilePreviewAdapter[] = [
  { id: 'markdown', extensions: ['.md', '.markdown'], renderer: 'markdown', source: textSource },
  {
    id: 'text', renderer: 'text', source: textSource,
    extensions: [
      '.txt', '.log', '.csv', '.tsv', '.json', '.jsonl', '.jsonc', '.xml', '.ini', '.conf', '.cfg',
      '.properties', '.yaml', '.yml', '.toml', '.sql', '.ps1', '.psm1', '.psd1', '.bat', '.cmd',
      '.py', '.pyw', '.pyi', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
      '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.astro', '.c', '.h', '.cpp', '.hpp',
      '.cc', '.cxx', '.hxx', '.cs', '.java', '.kt', '.kts', '.go', '.rs', '.rb', '.php',
      '.swift', '.m', '.mm', '.sh', '.bash', '.zsh', '.fish', '.r', '.lua', '.pl', '.pm',
      '.ex', '.exs', '.erl', '.hrl', '.hs', '.scala', '.dart', '.clj', '.cljs', '.edn',
      '.tex', '.rst', '.adoc', '.srt', '.vtt', '.diff', '.patch', '.graphql', '.gql', '.proto',
      '.cmake', '.gradle', '.env', '.lock', '.ipynb', '.http', '.tf', '.tfvars',
    ],
    fileNames: [
      'README', 'LICENSE', 'LICENCE', 'CHANGELOG', 'NOTICE', 'AUTHORS', 'COPYING',
      'Makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile', 'Gemfile', 'Rakefile', 'Procfile',
      '.gitignore', '.gitattributes', '.gitmodules', '.dockerignore', '.editorconfig',
      '.npmrc', '.nvmrc', '.yarnrc', '.prettierrc', '.eslintrc', '.bashrc', '.zshrc', '.profile',
    ],
  },
  {
    id: 'image', renderer: 'image', source: nativeSource,
    extensions: ['.png', '.apng', '.avif', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'],
  },
  { id: 'video', extensions: ['.mp4', '.m4v', '.mov', '.ogv', '.webm'], renderer: 'video', source: nativeSource },
  { id: 'audio', extensions: ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac'], renderer: 'audio', source: nativeSource },
  { id: 'html', extensions: ['.html', '.htm', '.xhtml'], renderer: 'webview', source: nativeSource },
  { id: 'pdf', extensions: ['.pdf'], renderer: 'webview', source: nativeSource },
  {
    id: 'blender', extensions: ['.blend'], renderer: 'webview',
    source: path => `cardbush-file://model-preview/?path=${encodeURIComponent(path)}`,
  },
  {
    id: 'office', extensions: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'], renderer: 'webview',
    source: (path, originalTarget) => /^cardbush-file:\/\/office-preview(?:\/|\?|$)/i.test(originalTarget ?? '')
      ? originalTarget!
      : `cardbush-file://office-preview/?path=${encodeURIComponent(path)}`,
  },
];

export const resolveFilePreview = createFilePreviewRegistry(filePreviewAdapters);
