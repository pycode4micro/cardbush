import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const app = read('src/App.tsx');
const chat = read('src/hooks/useCardbushChat.ts');
const composer = read('src/features/composer/Composer.tsx');
const messageBubble = read('src/features/chatMessages/MessageBubble.tsx');
const api = read('src/backend/api.ts');
const styles = read('src/styles/app.css');
const packageJson = JSON.parse(read('package.json'));
const readme = read('README.md');
const readmeZh = read('README.zh-CN.md');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(packageJson.version === '1.0.0-dev', 'desktop version must be 1.0.0-dev');
assert(packageJson.scripts['test:all'], 'test:all release gate is required');
assert(
  (app.match(/import\.meta\.env\.DEV && is(?:ComposerRuntime|LoopHistory|QuickContext)PreTestEnabled\(\)/g) ?? []).length === 3 &&
    app.includes('import.meta.env.DEV && LazyRuntimeStreamPreTest && isRuntimeStreamPreTestEnabled()'),
  'all pre-test entry points must be development-only',
);
assert(
  app.includes("window.localStorage.getItem('cardbush_scroll_debug') !== 'true'"),
  'scroll diagnostics must require an explicit production opt-in',
);
assert(
  app.includes("<BackendLoading language={language} />") &&
    app.includes("Connecting to backend service..."),
  'runtime loading state must support both UI languages',
);
assert(
  app.includes('function RuntimeStatusBanner(') &&
    app.includes("actionLabel={language === 'zh' ? '重试' : 'Retry'}") &&
    app.includes('await refreshBackendWithFeedback({ silent: false })'),
  'runtime errors must expose an inline localized retry action',
);
assert(
  app.includes('onToggleWorkSummary={renderMessages.length > 0') &&
    app.includes('onOpenReview={changeReports.length > 0 ? openChangeReview : undefined}') &&
    app.includes('conversationContentAvailable={renderMessages.length > 0}') &&
    app.includes('{conversationContentAvailable && onToggleWorkSummary && (') &&
    app.includes('{conversationContentAvailable && onOpenReview && reviewAvailable && ('),
  'conversation-only topbar actions must stay hidden on the welcome screen',
);
assert(
  app.includes('const [refreshError, setRefreshError]') &&
    app.includes('await refreshBackendWithFeedback({ silent: false })') &&
    app.includes('{(error || refreshError) && ('),
  'runtime refresh failures must use the shared retryable status banner',
);
assert(
  !app.includes('native-refresh-square') &&
    !app.includes('historyRefreshing') &&
    !app.includes('Reconnect backend and refresh sessions'),
  'the integrated client must not expose a permanent manual backend refresh in the chat toolbar',
);
assert(
  !app.includes('title="Git 控制台"') && !app.includes('title="终端控制台"'),
  'console titles must not be Chinese-only',
);
assert(
  !app.includes('onToggleGit') &&
    !app.includes('onToggleTerminal') &&
    !app.includes('ConsoleDock') &&
    !composer.includes('onOpenTerminalConsole') &&
    !composer.includes('terminalAvailable') &&
    !styles.includes('.console-dock') &&
    !styles.includes('.native-terminal') &&
    !existsSync(resolve(root, 'src/features/console/ConsoleDock.tsx')) &&
    packageJson.dependencies?.['@xterm/xterm'] == null,
  'retired product-side Git and terminal consoles must not return',
);
assert(
  app.includes("language === 'zh' ? '缓存' : 'Cache'") &&
    app.includes("language === 'zh' ? '最小化' : 'Minimize'"),
  'window frame actions must support both UI languages',
);
assert(
  messageBubble.includes("language === 'zh' ? '复制' : 'Copy'"),
  'markdown copy action must support both UI languages',
);
assert(
  messageBubble.includes('onAssistantFeedback?.(message, nextRating)') &&
    messageBubble.includes('反馈给 LEM'),
  'assistant thumbs must remain connected to LEM feedback',
);
assert(
  chat.includes('language?: AppLanguage') && chat.includes('const localize = useCallback'),
  'chat lifecycle errors must receive the active UI language',
);
assert(
  !/setError\((?:`|')\p{Script=Han}/u.test(chat),
  'chat errors must not be Chinese-only literals',
);
assert(
  !/setNotice\((?:`|')\p{Script=Han}/u.test(chat),
  'chat notices must not be Chinese-only literals',
);
assert(
  chat.includes('Unable to reach the model provider or an external integration') &&
    chat.includes('无法连接模型服务或外部集成'),
  'external connection failures must support both UI languages',
);
assert(
  !api.includes('/v1/') && !api.includes('BushServer') && !api.includes('VITE_BACKEND_BASE_URL'),
  'production API must not contain the retired local HTTP service boundary',
);
assert(
  api.includes('function localizedClientMessage') &&
    !/throw new Error\('.*\p{Script=Han}/u.test(api),
  'API validation errors must use localizedClientMessage',
);
assert(!readme.includes('C:\\Users\\'), 'README must not contain a developer-specific path');
assert(readme.includes('1.0.0-dev') && readmeZh.includes('1.0.0-dev'), 'both READMEs must describe the development version');
assert(readme.includes('README.zh-CN.md'), 'English README must link to the Chinese README');
assert(readmeZh.includes('README.md'), 'Chinese README must link to the English README');

if (process.argv.includes('--dist')) {
  const assetsDir = resolve(root, 'dist/assets');
  assert(existsSync(assetsDir), 'dist/assets is missing; run the production build first');
  const productionJavaScript = readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(resolve(assetsDir, name), 'utf8'))
    .join('\n');
  assert(
    !productionJavaScript.includes('cardbush_pre_test'),
    'production bundle still contains the pre-test activation key',
  );
  assert(
    !productionJavaScript.includes('bush.runtime_fixture.v1') &&
      !productionJavaScript.includes('single-turn-reasoning-assistant-terminal'),
    'production bundle still contains the runtime protocol fixture',
  );
}

console.log(`release cleanup contract tests passed${process.argv.includes('--dist') ? ' (production bundle)' : ''}`);
