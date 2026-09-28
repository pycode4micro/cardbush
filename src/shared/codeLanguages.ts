import { resourceBasename } from './localPaths';

type CodeLanguage = {
  id: string;
  label: string;
  extensions: string[];
  aliases: string[];
  grammar: string;
};

function language(id: string, label: string, extensions = '', aliases = '', grammar = id): CodeLanguage {
  return { id, label, extensions: extensions.split(' ').filter(Boolean), aliases: aliases.split(' ').filter(Boolean), grammar };
}

// The light registry is shared by fences, file previews, diffs and file icons.
// Grammar implementations live separately in the lazy syntax renderer.
export const codeLanguages: CodeLanguage[] = [
  language('plain', 'Plain text', 'txt text log', 'text txt plaintext none'),
  language('c', 'C', 'c h'),
  language('cpp', 'C++', 'cc cpp cxx c++ hh hpp hxx h++ ipp tpp cu cuh', 'c++ cxx cc'),
  language('csharp', 'C#', 'cs csx', 'cs c# c-sharp dotnet'),
  language('fsharp', 'F#', 'fs fsx fsi', 'fs f#'),
  language('vbnet', 'Visual Basic', 'vb vbs', 'vb visual-basic'),
  language('java', 'Java', 'java'),
  language('javascript', 'JavaScript', 'js mjs cjs', 'js node nodejs'),
  language('jsx', 'JSX', 'jsx'),
  language('typescript', 'TypeScript', 'ts mts cts', 'ts'),
  language('tsx', 'TSX', 'tsx'),
  language('python', 'Python', 'py pyi pyw', 'py python3 py3'),
  language('ruby', 'Ruby', 'rb rbw rake gemspec', 'rb'),
  language('php', 'PHP', 'php php3 php4 php5 php7 php8 phtml'),
  language('go', 'Go', 'go', 'golang'),
  language('rust', 'Rust', 'rs', 'rs'),
  language('kotlin', 'Kotlin', 'kt kts', 'kt kts'),
  language('swift', 'Swift', 'swift'),
  language('objectivec', 'Objective-C', 'm mm objc', 'objc objective-c'),
  language('dart', 'Dart', 'dart'),
  language('lua', 'Lua', 'lua'),
  language('r', 'R', 'r'),
  language('scala', 'Scala', 'scala sc'),
  language('groovy', 'Groovy', 'groovy gradle gvy'),
  language('perl', 'Perl', 'pl pm', 'pl'),
  language('powershell', 'PowerShell', 'ps1 psm1 psd1', 'pwsh ps1'),
  language('bash', 'Shell', 'sh bash zsh', 'sh shell zsh console shell-session'),
  language('batch', 'Batch', 'bat cmd', 'bat cmd dos'),
  language('sql', 'SQL', 'sql'),
  language('graphql', 'GraphQL', 'graphql gql', 'gql'),
  language('markup', 'HTML/XML', 'html htm xhtml xml svg xaml axaml csproj fsproj vbproj props targets resx nuspec plist config manifest ui', 'html xml svg mathml ssml atom rss'),
  language('vue', 'Vue', 'vue', '', 'markup'),
  language('svelte', 'Svelte', 'svelte', '', 'markup'),
  language('css', 'CSS', 'css'),
  language('scss', 'SCSS', 'scss'),
  language('sass', 'Sass', 'sass'),
  language('less', 'Less', 'less'),
  language('json', 'JSON', 'json jsonl ndjson webmanifest ipynb', 'jsonl ndjson webmanifest'),
  language('json5', 'JSON5', 'json5'),
  language('jsonc', 'JSONC', 'jsonc', '', 'json5'),
  language('yaml', 'YAML', 'yaml yml', 'yml'),
  language('toml', 'TOML', 'toml'),
  language('ini', 'INI', 'ini cfg properties env editorconfig', 'dotenv'),
  language('docker', 'Dockerfile', 'dockerfile', 'dockerfile'),
  language('makefile', 'Makefile', 'mk mak', 'make'),
  language('cmake', 'CMake', 'cmake'),
  language('diff', 'Diff', 'diff patch', 'patch'),
  language('markdown', 'Markdown', 'md markdown mdx rmd', 'md mdx'),
  language('latex', 'LaTeX', 'tex sty cls bib', 'tex context'),
  language('protobuf', 'Protocol Buffers', 'proto', 'proto'),
  language('hcl', 'HCL', 'hcl tf tfvars', 'terraform'),
  language('nginx', 'Nginx', '', 'nginxconf'),
  language('clojure', 'Clojure', 'clj cljs cljc edn', 'clj cljs'),
  language('elixir', 'Elixir', 'ex exs'),
  language('erlang', 'Erlang', 'erl hrl', 'erl'),
  language('haskell', 'Haskell', 'hs lhs', 'hs'),
  language('julia', 'Julia', 'jl', 'jl'),
  language('zig', 'Zig', 'zig zon'),
  language('wasm', 'WebAssembly', 'wat wast', 'wat webassembly'),
  language('regex', 'RegExp', '', 'regexp'),
  language('coffeescript', 'CoffeeScript', 'coffee', 'coffee'),
  language('actionscript', 'ActionScript', 'as', 'as3'),
  language('flow', 'Flow', '', 'flowtype'),
  language('reason', 'Reason', 're rei'),
  language('clike', 'C-like'),
];

const byAlias = new Map(codeLanguages.flatMap(item => [item.id, ...item.aliases].map(alias => [alias, item] as const)));
const byExtension = new Map(codeLanguages.flatMap(item => item.extensions.map(extension => [extension, item] as const)));
const specialNames: Record<string, string> = {
  dockerfile: 'docker', containerfile: 'docker', makefile: 'makefile', gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake', gemfile: 'ruby', rakefile: 'ruby', guardfile: 'ruby',
  jenkinsfile: 'groovy', vagrantfile: 'ruby', '.bashrc': 'bash', '.bash_profile': 'bash', '.zshrc': 'bash',
  '.profile': 'bash', '.npmrc': 'ini', '.yarnrc': 'yaml', '.gitconfig': 'ini', '.editorconfig': 'ini',
  'nginx.conf': 'nginx',
};

export function codeLanguageForFence(value: string): CodeLanguage | undefined {
  return byAlias.get(value.trim().toLowerCase());
}

export function codeLanguageForPath(path: string): CodeLanguage | undefined {
  const filename = resourceBasename(path).toLowerCase();
  const special = specialNames[filename] ?? (/^(?:dockerfile|containerfile)\./.test(filename) ? 'docker'
    : /^\.env(?:\.|$)/.test(filename) ? 'ini' : undefined);
  if (special) return byAlias.get(special);
  return byExtension.get(filename.includes('.') ? filename.split('.').at(-1)! : '');
}

export function codeLanguageLabel(value: string, language: 'zh' | 'en'): string {
  const descriptor = codeLanguageForFence(value);
  if (!value || descriptor?.id === 'plain') return language === 'zh' ? '纯文本' : 'Plain text';
  const normalized = value.trim().toLowerCase();
  if (['html', 'xml', 'svg'].includes(normalized)) return normalized.toUpperCase();
  // Keep an unknown fence's authored label without claiming syntax support.
  return descriptor?.label ?? value;
}
