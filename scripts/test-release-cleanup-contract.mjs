import { readSourceFile } from './helpers/read-source-file.cjs';
import { assertUiMessage } from './helpers/ui-message-contract.mjs';
import { readAppViewSources } from './helpers/app-view-sources.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readSourceFile(resolve(root, path), 'utf8');
const app = readAppViewSources();
const chat = read('src/hooks/useCardbushChat.ts');
const composer = read('src/features/composer/Composer.tsx');
const windowFrame = read('src/components/WindowFrame.tsx');
const messageBubble = read('src/features/chatMessages/MessageBubble.tsx');
const api = read('src/backend/api.ts');
const styles = read('src/styles/app.css');
const protocolModel = read('packages/bush-protocol/src/model.ts');
const runtimeHost = read('packages/bush-runtime/src/inMemoryRuntimeHost.ts');
const runtimeInteractionTools = read('packages/bush-runtime/src/interactionTools.ts');
const productAgent = read('packages/bush-product-agent/src/index.ts');
const runtimeChat = read('src/backend/runtimeChat.ts');
const toolLogo = read('src/features/tools/ToolLogo.tsx');
const packageJson = JSON.parse(read('package.json'));
const readme = read('README.md');
const readmeZh = read('README.zh-CN.md');
const retiredChoiceMarkers = [
  ['request', 'user', 'choice'].join('_'),
  ['generic', 'user', 'choice'].join('_'),
  ['user', 'Choice'].join(''),
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(packageJson.version), 'desktop version must be a semantic release version');
assert(packageJson.scripts['test:all'], 'test:all release gate is required');
assert(
  (app.match(/import\.meta\.env\.DEV && is(?:ComposerRuntime|LoopHistory|QuickContext)PreTestEnabled\(\)/g) ?? []).length === 3 &&
    app.includes('import.meta.env.DEV && LazyRuntimeStreamPreTest && isRuntimeStreamPreTestEnabled()'),
  'all pre-test entry points must be development-only',
);
assert(
  app.includes("window.sessionStorage.getItem('cardbush_scroll_debug') === 'true'") &&
    app.includes('if (!scrollDebugEnabled()) return;') &&
    !app.includes("window.localStorage.getItem('cardbush_scroll_debug')"),
  'scroll diagnostics must require an explicit process-scoped opt-in',
);
assert(
  app.includes("<BackendLoading language={language} history={historyLoading} />") &&
    app.includes("uiText(language)('chatStatusViews.connectingToTheRuntime')"),
  'runtime loading state must support both UI languages',
);
assertUiMessage(app, 'chatStatusViews.connectingToTheRuntime', { zh: '正在连接运行服务...', en: 'Connecting to the runtime...' });
assert(
  app.includes('function RuntimeStatusBanner(') &&
    app.includes("actionLabel={uiText(language)('common.retry')}") &&
    app.includes('await refreshBackendWithFeedback({ silent: false })'),
  'runtime errors must expose an inline localized retry action',
);
assert(
  app.includes('onToggleWorkSummary={workSummaryAvailable && renderMessages.length > 0') &&
    app.includes('onToggleInspector={onToggleInspector}') &&
    app.includes('conversationContentAvailable={renderMessages.length > 0}') &&
    app.includes('{conversationContentAvailable && onToggleWorkSummary && (') &&
    !app.includes('conversationContentAvailable && onToggleInspector'),
  'only the work summary requires conversation content; the sidebar stays available on welcome',
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
for (const [key, zh, en] of [
  ['windowFrame.minimize', '最小化', 'Minimize'], ['windowFrame.maximize', '最大化', 'Maximize'],
  ['windowFrame.restore', '还原窗口', 'Restore'], ['common.close', '关闭', 'Close'],
]) assertUiMessage(windowFrame, key, { zh, en });
assert(!windowFrame.includes('cache-chip'), 'the retired title-bar cache button must not return');
assertUiMessage(messageBubble, 'messageBubble.copy', { zh: '复制', en: 'Copy' });
assert(
  messageBubble.includes('await recordAssistantFeedback(message, nextRating, {') &&
    !messageBubble.includes('反馈给 LEM'),
  'assistant thumbs use the built-in feedback service without requiring an optional memory plugin',
);
assert(
  chat.includes('language?: AppLanguage') && chat.includes('languageRef.current = requestContext.language') && chat.includes('uiText(languageRef.current)'),
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
assertUiMessage(chat, 'useCardbushChat.could_not_connect_to_the_model_service', {
  zh: '无法连接模型服务或外部集成。', en: 'Could not connect to the model service or external integration.',
});
assert(
  !api.includes('/v1/') && !api.includes('BushServer') && !api.includes('VITE_BACKEND_BASE_URL'),
  'production API must not contain the retired local HTTP service boundary',
);
assert(
  [
    protocolModel,
    runtimeHost,
    runtimeInteractionTools,
    productAgent,
    runtimeChat,
    toolLogo,
    api,
  ].every((source) => retiredChoiceMarkers.every((marker) => !source.includes(marker))) &&
    !existsSync(resolve(root, 'packages/bush-protocol/src/interaction.ts')) &&
    !existsSync(resolve(root, 'packages/bush-runtime/src/runtimeInteractionStore.ts')),
  'retired generic user-choice Tool and protocol must not return',
);
assert(
  api.includes("import { uiText } from '../i18n'") &&
    /throw new Error\(\s*uiText\(undefined\)\('api\./.test(api) &&
    !/throw new Error\('.*\p{Script=Han}/u.test(api),
  'API validation errors must use the shared language catalog',
);
assert(!readme.includes('C:\\Users\\'), 'README must not contain a developer-specific path');
assert(readme.includes(packageJson.version) && readmeZh.includes(packageJson.version), 'both READMEs must describe the release version');
assert(readme.includes('README.zh-CN.md'), 'English README must link to the Chinese README');
assert(readmeZh.includes('README.md'), 'Chinese README must link to the English README');

if (process.argv.includes('--dist')) {
  const assetsDir = resolve(root, 'dist/assets');
  assert(existsSync(assetsDir), 'dist/assets is missing; run the production build first');
  // Vite retains older chunks for open windows. Check every retained file but
  // never concatenate the entire history into a string larger than V8 allows.
  for (const name of readdirSync(assetsDir).filter(name => name.endsWith('.js'))) {
    const productionJavaScript = readSourceFile(resolve(assetsDir, name), 'utf8');
    assert(
      !productionJavaScript.includes('cardbush_pre_test'),
      `production bundle still contains the pre-test activation key: ${name}`,
    );
    assert(
      !productionJavaScript.includes('bush.runtime_fixture.v1') &&
        !productionJavaScript.includes('single-turn-reasoning-assistant-terminal'),
      `production bundle still contains the runtime protocol fixture: ${name}`,
    );
  }
}

console.log(`release cleanup contract tests passed${process.argv.includes('--dist') ? ' (production bundle)' : ''}`);
