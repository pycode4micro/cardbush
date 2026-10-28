import { uiText } from '../../i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  BUSH_MODEL_REQUEST_PROTOCOL,
  BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL,
} from '@cardbush/bush-protocol';

import runtimeFixture from '../../../packages/bush-protocol/reference-fixtures/single-turn-stream.v1.json';
import {
  RuntimeTurnStore,
  createDesktopRuntimeSession,
  createRuntimeFixtureClient,
  useRuntimeTurnStore,
} from '../../runtime-client';
import type { AppLanguage, ChatMessage, ManagedModelConfig } from '../../types';
import { MessageBubble } from '../chatMessages';
import type { RuntimeStreamPreTestMode } from './runtimeStreamPreTestActivation';

export function RuntimeStreamPreTest({
  language,
  mode = 'fixture',
  modelConfig,
}: {
  language: AppLanguage;
  mode?: RuntimeStreamPreTestMode;
  modelConfig?: ManagedModelConfig;
}) {
  return mode === 'live' ? (
    <RuntimeLivePreTest language={language} modelConfig={modelConfig} />
  ) : (
    <RuntimeFixturePreTest language={language} />
  );
}

function RuntimeFixturePreTest({ language }: { language: AppLanguage }) {
  const setup = useMemo(() => {
    const fixtureClient = createRuntimeFixtureClient(runtimeFixture, {
      minimumDelayMs: 420,
    });
    return {
      ...fixtureClient,
      store: new RuntimeTurnStore(fixtureClient.client),
    };
  }, []);
  const state = useRuntimeTurnStore(setup.store);
  const firstEvent = setup.fixture.events[0]?.event;
  const replay = useCallback(async () => {
    await setup.store.discoverCapabilities();
    await setup.store.start({
      sessionId: firstEvent.sessionId,
      turnId: firstEvent.turnId,
    });
  }, [firstEvent.sessionId, firstEvent.turnId, setup.store]);

  useEffect(() => {
    void replay().catch(() => undefined);
    return () => setup.store.cancel();
  }, [replay, setup.store]);

  const reasoningContent = state.view.reasoningSegments
    .map((segment) => segment.content)
    .join('');
  const assistantContent = state.view.assistantSegments
    .map((segment) => segment.content)
    .join('');
  const assistantMessage: ChatMessage | null = assistantContent
    ? {
        id: state.view.terminal?.finalMessageId ?? 'runtime-fixture-assistant',
        turnId: state.view.turnId,
        role: 'assistant',
        content: assistantContent,
        createdAt: firstEvent.createdAt,
      }
    : null;
  const streaming = state.streamState === 'streaming';
  const terminal = state.view.terminal;

  return (
    <div className="chat-panel runtime-stream-pre-test">
      <header className="runtime-stream-pre-test-header">
        <span>
          <strong>
            {uiText(language)('runtimeStreamPreTest.runtimeEventFirstConsumerPreTest')}
          </strong>
          <small>
            {setup.fixture.name} · {setup.fixture.protocol}
          </small>
        </span>
        <div className="runtime-stream-pre-test-actions">
          <output data-state={state.streamState}>
            {runtimeStateLabel(state.streamState, language)} · {state.eventCount}/
            {setup.fixture.events.length}
          </output>
          <button type="button" onClick={() => void replay().catch(() => undefined)}>
            {uiText(language)('runtimeStreamPreTest.replay')}
          </button>
        </div>
      </header>

      <main className="runtime-stream-pre-test-stage">
        <section className="runtime-stream-pre-test-contract">
          <span>
            <small>{uiText(language)('runtimeStreamPreTest.protocol')}</small>
            <strong>{state.capabilities?.eventProtocol ?? '—'}</strong>
          </span>
          <span>
            <small>{uiText(language)('runtimeStreamPreTest.lastEvent')}</small>
            <strong>{state.lastEventKind ?? '—'}</strong>
          </span>
          <span>
            <small>{uiText(language)('runtimeStreamPreTest.terminalSource')}</small>
            <strong>{terminal ? 'turn_terminal' : '—'}</strong>
          </span>
        </section>

        {state.error && (
          <section className="runtime-stream-pre-test-error" role="alert">
            <strong>{uiText(language)('runtimeStreamPreTest.protocolConsumerFailed')}</strong>
            <span>{state.error}</span>
          </section>
        )}

        <section className="runtime-stream-pre-test-transcript">
          <article className="runtime-stream-pre-test-user">
            {uiText(language)('runtimeStreamPreTest.verifyThatTheFirstRuntimeStreamSeparates')}
          </article>

          {(reasoningContent || streaming) && (
            <section
              className={`runtime-stream-pre-test-reasoning${
                state.view.reasoningSegments.some((segment) => !segment.completed)
                  ? ' active'
                  : ''
              }`}
            >
              <small>Thinking</small>
              <p>
                {reasoningContent ||
                  (uiText(language)('runtimeStreamPreTest.waitingForReasoningEvents'))}
              </p>
            </section>
          )}

          {assistantMessage ? (
            <div className="message-list runtime-stream-pre-test-message">
              <MessageBubble
                message={assistantMessage}
                language={language}
                sending={streaming}
                activeTurnId={state.view.turnId ?? ''}
                activeAssistantMessageId={assistantMessage.id}
                selectedModel="fixture-runtime"
                onRegenerate={async () => undefined}
                onEditUserMessage={async () => undefined}
                onRetryGuidance={async () => undefined}
                onRevertChangeReport={async () => undefined}
                onOpenScene={() => undefined}
              />
            </div>
          ) : (
            <div className="runtime-stream-pre-test-waiting">
              {uiText(language)('runtimeStreamPreTest.waitingForAssistantSegment')}
            </div>
          )}
        </section>

        <footer className="runtime-stream-pre-test-terminal">
          <small>{uiText(language)('runtimeStreamPreTest.explicitTerminal')}</small>
          <strong>{terminal?.status ?? (uiText(language)('runtimeStreamPreTest.notReceived'))}</strong>
          <span>{terminal?.reason ?? 'turn_terminal pending'}</span>
        </footer>
      </main>
    </div>
  );
}

function RuntimeLivePreTest({
  language,
  modelConfig,
}: {
  language: AppLanguage;
  modelConfig?: ManagedModelConfig;
}) {
  if (!window.cardbushDesktop?.runtime) {
    return (
      <div className="chat-panel runtime-stream-pre-test">
        <section className="runtime-stream-pre-test-error" role="alert">
          <strong>Runtime Host unavailable</strong>
          <span>The typed Electron Runtime bridge is not available.</span>
        </section>
      </div>
    );
  }
  return (
    <ConnectedRuntimeLivePreTest language={language} modelConfig={modelConfig} />
  );
}

function ConnectedRuntimeLivePreTest({
  language,
  modelConfig,
}: {
  language: AppLanguage;
  modelConfig?: ManagedModelConfig;
}) {
  const session = useMemo(() => createDesktopRuntimeSession(), []);
  const state = useRuntimeTurnStore(session.store);
  const [prompt, setPrompt] = useState(
    uiText(language)('runtimeStreamPreTest.confirmInOneSentenceThatThisMessage'),
  );
  const [submittedPrompt, setSubmittedPrompt] = useState('');
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    void session.discoverCapabilities().catch((caught) => {
      setError(errorMessage(caught));
    });
    return () => session.dispose();
  }, [session]);

  const run = useCallback(async () => {
    const content = prompt.trim();
    if (!content) return;
    if (!modelConfig?.apiKey.trim()) {
      setError(
        uiText(language)('runtimeStreamPreTest.theSelectedModelConfigurationHasNoUsable'),
      );
      return;
    }
    setRunning(true);
    setError('');
    setSubmittedPrompt(content);
    try {
      const configured = await session.configureProvider({
        protocol: BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL,
        bindingId: modelConfig.id,
        adapter: 'openai_responses',
        apiKey: modelConfig.apiKey,
        baseURL: modelConfig.baseUrl.trim() || undefined,
        defaultHeaders: {},
      });
      if (configured.status !== 'configured') {
        throw new Error(`Provider binding returned ${configured.status}.`);
      }
      const suffix = crypto.randomUUID();
      await session.run({
        protocol: BUSH_MODEL_REQUEST_PROTOCOL,
        requestId: `request_runtime_live_${suffix}`,
        sessionId: `session_runtime_live_${suffix}`,
        turnId: `turn_runtime_live_${suffix}`,
        model: modelConfig.modelName,
        providerBinding: configured.binding,
        messages: [{ role: 'user', content }],
        tools: [],
      requestCapabilities: {
        vision: false,
        interactiveRequests: true,
      },
      permissionMode: 'task_free',
      metadata: {},
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRunning(false);
    }
  }, [language, modelConfig, prompt, session]);

  const reasoningContent = state.view.reasoningSegments
    .map((segment) => segment.content)
    .join('');
  const assistantContent = state.view.assistantSegments
    .map((segment) => segment.content)
    .join('');
  const assistantMessage: ChatMessage | null = assistantContent
    ? {
        id: state.view.terminal?.finalMessageId ?? 'runtime-live-assistant',
        turnId: state.view.turnId,
        role: 'assistant',
        content: assistantContent,
        createdAt: new Date().toISOString(),
      }
    : null;

  return (
    <div className="chat-panel runtime-stream-pre-test">
      <header className="runtime-stream-pre-test-header">
        <span>
          <strong>
            {uiText(language)('runtimeStreamPreTest.typescriptRuntimeLiveGate')}
          </strong>
          <small>
            {modelConfig
              ? `${modelConfig.provider} · ${modelConfig.modelName}`
              : uiText(language)('runtimeStreamPreTest.noModelConfigurationSelected')}
          </small>
        </span>
        <output data-state={state.streamState}>
          {runtimeStateLabel(state.streamState, language)} · {state.eventCount}
        </output>
      </header>

      <main className="runtime-stream-pre-test-stage">
        <section className="runtime-stream-pre-test-contract">
          <span>
            <small>{uiText(language)('runtimeStreamPreTest.protocol')}</small>
            <strong>{state.capabilities?.eventProtocol ?? '—'}</strong>
          </span>
          <span>
            <small>{uiText(language)('runtimeStreamPreTest.host')}</small>
            <strong>{state.capabilities?.hostId ?? '—'}</strong>
          </span>
          <span>
            <small>{uiText(language)('runtimeStreamPreTest.terminal')}</small>
            <strong>{state.view.terminal?.status ?? '—'}</strong>
          </span>
        </section>

        <form
          className="runtime-live-pre-test-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={running}
            aria-label={uiText(language)('runtimeStreamPreTest.liveRuntimeTestMessage')}
          />
          <button type="submit" disabled={running || !modelConfig}>
            {running
              ? uiText(language)('runtimeStreamPreTest.running')
              : uiText(language)('runtimeStreamPreTest.runLiveTurn')}
          </button>
        </form>

        {(error || state.error) && (
          <section className="runtime-stream-pre-test-error" role="alert">
            <strong>{uiText(language)('runtimeStreamPreTest.liveGateFailed')}</strong>
            <span>{error || state.error}</span>
          </section>
        )}

        <section className="runtime-stream-pre-test-transcript">
          {submittedPrompt && (
            <article className="runtime-stream-pre-test-user">{submittedPrompt}</article>
          )}
          {reasoningContent && (
            <section className="runtime-stream-pre-test-reasoning">
              <small>Thinking</small>
              <p>{reasoningContent}</p>
            </section>
          )}
          {assistantMessage && (
            <div className="message-list runtime-stream-pre-test-message">
              <MessageBubble
                message={assistantMessage}
                language={language}
                sending={running}
                activeTurnId={state.view.turnId ?? ''}
                activeAssistantMessageId={assistantMessage.id}
                selectedModel={modelConfig?.modelName ?? ''}
                onRegenerate={async () => undefined}
                onEditUserMessage={async () => undefined}
                onRetryGuidance={async () => undefined}
                onRevertChangeReport={async () => undefined}
                onOpenScene={() => undefined}
              />
            </div>
          )}
        </section>

        <footer className="runtime-stream-pre-test-terminal">
          <small>{uiText(language)('runtimeStreamPreTest.runtimeTerminalFact')}</small>
          <strong>{state.view.terminal?.status ?? 'pending'}</strong>
          <span>{state.view.terminal?.reason ?? state.lastEventKind ?? '—'}</span>
        </footer>
      </main>
    </div>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function runtimeStateLabel(
  state: ReturnType<typeof useRuntimeTurnStore>['streamState'],
  language: AppLanguage,
) {
  const labels = ({ idle: uiText(language)('runtimeStreamPreTest.idle'), discovering: uiText(language)('runtimeStreamPreTest.discovering'), ready: uiText(language)('runtimeStreamPreTest.ready'), streaming: uiText(language)('runtimeStreamPreTest.streaming'), settled: uiText(language)('runtimeStreamPreTest.settled'), error: uiText(language)('runtimeStreamPreTest.error') });
  return labels[state];
}
