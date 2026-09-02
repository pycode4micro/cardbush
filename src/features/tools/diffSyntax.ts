import type { DiffLine } from './toolChangeReports';

const languageByExtension: Record<string, string> = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  css: 'css',
  go: 'go',
  gql: 'graphql',
  graphql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  htm: 'markup',
  html: 'markup',
  java: 'clike',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'css',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  objc: 'objectivec',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  scss: 'css',
  sql: 'sql',
  svg: 'markup',
  swift: 'swift',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'markup',
  webmanifest: 'json',
  xml: 'markup',
  yaml: 'yaml',
  yml: 'yaml',
};

export function diffLanguageForPath(path: string) {
  const filename = path.trim().split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  if (filename === 'package.json' || filename === 'tsconfig.json') return 'json';
  const extension = filename.includes('.') ? filename.split('.').at(-1) ?? '' : '';
  return languageByExtension[extension] ?? 'plain';
}

export function diffLinePrefix(line: DiffLine) {
  if (line.kind === 'addition') return '+';
  if (line.kind === 'deletion') return '-';
  return ' ';
}

export function diffLineSource(line: DiffLine) {
  if (line.kind === 'hunk') return line.text;
  return /^[+\- ]/.test(line.text) ? line.text.slice(1) : line.text;
}

export type DiffLineNumber = {
  oldLine: number | null;
  newLine: number | null;
};

export function diffLineNumbers(lines: DiffLine[]): DiffLineNumber[] {
  let oldLine = 1;
  let newLine = 1;

  return lines.map((line) => {
    if (line.kind === 'hunk') {
      const range = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line.text);
      if (range) {
        oldLine = Number.parseInt(range[1] ?? '1', 10);
        newLine = Number.parseInt(range[2] ?? '1', 10);
      }
      return { oldLine: null, newLine: null };
    }

    if (line.kind === 'addition') {
      const current = { oldLine: null, newLine };
      newLine += 1;
      return current;
    }

    if (line.kind === 'deletion') {
      const current = { oldLine, newLine: null };
      oldLine += 1;
      return current;
    }

    const current = { oldLine, newLine };
    oldLine += 1;
    newLine += 1;
    return current;
  });
}
