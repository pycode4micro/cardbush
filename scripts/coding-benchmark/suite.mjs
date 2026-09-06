// Reproducible repair tasks derived from real CardBush modules. Mutations are
// deliberately seeded regressions, not a claim of naturally occurring bugs.
const queue = 'src/features/composer/queueOrdering.ts';
const paths = 'src/shared/localPaths.ts';
const inspector = 'src/features/inspector/inspectorTargets.ts';
const markdown = 'src/features/chatMessages/markdownFormat.ts';
const references = 'src/features/chatMessages/fileReferences.ts';
const atomic = 'packages/cardbush-product-host/src/atomicFiles.ts';
const usage = 'src/backend/contextWindowUsage.ts';

export const suite = [
  {
    id: 'queue-scope', files: [queue], category: 'local-bug',
    prompt: '修复队列拖拽跨会话串位：只有 source 和 target 属于同一 scope 时才能移动。跨 scope、未知 id、同一个 id 都必须原样返回原数组，不能影响其他 scope 的位置或修改输入。保留公开 API，并运行测试。',
    mutations: [
      { path: queue, before: '!source || !target || scopeOf(source) !== scopeOf(target)', after: '!source || !target' },
      { path: queue, before: 'sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex', after: 'sourceIndex < 0 || sourceIndex === targetIndex' },
    ],
  },
  {
    id: 'queue-stable-move', files: [queue], category: 'local-bug',
    prompt: '修复同一会话队列中向后拖拽的位置偏差：source 应移动到 target 在该 scope 中原有的索引。向前、向后都应正确，其他会话项目应留在原位置。保留输入对象与数组，不要原地修改。补充回归测试并验证。',
    mutations: [{ path: queue, before: 'reorderedScope.splice(targetIndex, 0, moved);', after: 'reorderedScope.splice(Math.max(0, targetIndex - 1), 0, moved);' }],
  },
  {
    id: 'config-concurrency', files: [atomic], category: 'async-concurrency',
    prompt: '同一配置文件的并发 read/modify/write 会丢更新。修复 withConfigFileLock，让同一规范化路径按调用顺序串行执行，不同路径可并行；一次操作失败后，下一次仍能运行。保持返回值和异常传播，验证并发与失败恢复。',
    mutations: [{ path: atomic, before: 'const result = (fileOperations.get(key) ?? Promise.resolve()).then(operation);', after: 'const result = Promise.resolve().then(operation);' }],
  },
  {
    id: 'context-usage', files: [usage], category: 'accounting',
    prompt: '修复上下文占用率显示：使用最近一次模型请求的 lastRequestInputTokens，不能用累计计费用的 inputTokens。最近请求未知时保持未知；超过窗口时剩余为 0，但保留真实 ratio。验证窗口配置回退和非法数值。',
    mutations: [{ path: usage, before: 'nonnegativeInteger(usage?.lastRequestInputTokens)', after: 'nonnegativeInteger(usage?.inputTokens)' }],
  },
  {
    id: 'local-url-encoding', files: [paths], category: 'path-handling',
    prompt: '本地文件路径包含空格、中文、# 或 % 时预览 URL 损坏。修复 fileUrl 的分段编码：保留盘符冒号和目录分隔符，编码每段的特殊字符，已编码的 file URL 不应双重编码。保持浏览器和桌面两种 scheme，写测试验证。',
    mutations: [{ path: paths, before: ': encodeURIComponent(segment),', after: ': segment,' }],
  },
  {
    id: 'flac-preview', files: [paths, inspector], category: 'cross-file',
    prompt: '恢复 FLAC 音频在共享媒体识别和右侧预览中的支持。本地 .flac 应识别为 audio，并使用原生媒体文件预览而非文本预览；大小写不敏感，含 # 的真实文件名和 UNC 路径应保留。同时保证现有图片、视频、文本预览行为不变，验证所有入口。',
    mutations: [
      { path: paths, before: 'ogg|oga|opus|flac', after: 'ogg|oga|opus' },
      { path: inspector, before: 'ogg|oga|opus|flac|webm', after: 'ogg|oga|opus|webm' },
    ],
  },
  {
    id: 'markdown-code-boundary', files: [markdown], category: 'text-parsing',
    prompt: '修复 Markdown 展示对代码内容的误改：加粗的裸 URL 在正文可以变成链接，但 fenced code 和 inline code 中必须逐字保留，包含多反引号代码跨度与 CRLF。维持原有命令 fence 修正和空 fence 清理功能。添加测试并验证。',
    mutations: [{ path: markdown, before: 'return transformMarkdownProse(withoutEmptyFences, normalizeEmphasizedBareLinks);', after: 'return normalizeEmphasizedBareLinks(withoutEmptyFences);' }],
  },
  {
    id: 'file-reference-boundary', files: [references, paths], category: 'repository-navigation',
    prompt: '修复聊天文件引用中的日期误识别：普通日期 2026/9/29 不能被部分识别成 POSIX 路径；真正的绝对路径 /tmp/reports/result.json 应继续识别。找到负责裸路径识别的逻辑，保留 Windows、UNC 和相对文件引用行为，验证修复。',
    mutations: [{ path: references, before: '(?<![\\p{L}\\p{N}_])\\/', after: '\\/' }],
  },
];

export const benchmarkTools = new Set([
  'read_file', 'search_file_content', 'write_file', 'edit_file',
  'terminal_exec', 'terminal_poll', 'terminal_write', 'terminal_stop', 'terminal_list',
  'checkpoint_context', 'read_archived_tool_result', 'update_task_plan',
]);
