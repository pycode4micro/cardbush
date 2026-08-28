import { useCallback, useEffect, useMemo } from 'react';

import runtimeFixture from '../../../packages/bush-protocol/reference-fixtures/single-turn-stream.v1.json';
import {
  RuntimeTurnStore,
  createRuntimeFixtureClient,
  useRuntimeTurnStore,
} from '../../runtime-client';
import type { AppLanguage, ChatMessage } from '../../types';
import { MessageBubble } from '../chatMessages';

export function RuntimeStreamPreTest({ language }: { language: AppLanguage }) {
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
            {language === 'zh'
              ? 'Runtime Event 首轮消费 · Pre Test'
              : 'Runtime Event first consumer · Pre Test'}
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
            {language === 'zh' ? '重新播放' : 'Replay'}
          </button>
        </div>
      </header>

      <main className="runtime-stream-pre-test-stage">
        <section className="runtime-stream-pre-test-contract">
          <span>
            <small>{language === 'zh' ? '协议' : 'Protocol'}</small>
            <strong>{state.capabilities?.eventProtocol ?? '—'}</strong>
          </span>
          <span>
            <small>{language === 'zh' ? '最后事件' : 'Last event'}</small>
            <strong>{state.lastEventKind ?? '—'}</strong>
          </span>
          <span>
            <small>{language === 'zh' ? '终态来源' : 'Terminal source'}</small>
            <strong>{terminal ? 'turn_terminal' : '—'}</strong>
          </span>
        </section>

        {state.error && (
          <section className="runtime-stream-pre-test-error" role="alert">
            <strong>{language === 'zh' ? '协议消费失败' : 'Protocol consumer failed'}</strong>
            <span>{state.error}</span>
          </section>
        )}

        <section className="runtime-stream-pre-test-transcript">
          <article className="runtime-stream-pre-test-user">
            {language === 'zh'
              ? '验证首轮 Runtime 流是否保持 Thinking、Assistant 与终态分离。'
              : 'Verify that the first Runtime stream separates Thinking, Assistant and terminal state.'}
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
                  (language === 'zh' ? '等待推理事件…' : 'Waiting for reasoning events…')}
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
                onGuideMessage={async () => undefined}
                onRetryGuidance={async () => undefined}
                onRevertChangeReport={async () => undefined}
                onOpenScene={() => undefined}
              />
            </div>
          ) : (
            <div className="runtime-stream-pre-test-waiting">
              {language === 'zh'
                ? '等待 assistant_segment…'
                : 'Waiting for assistant_segment…'}
            </div>
          )}
        </section>

        <footer className="runtime-stream-pre-test-terminal">
          <small>{language === 'zh' ? '明确终态' : 'Explicit terminal'}</small>
          <strong>{terminal?.status ?? (language === 'zh' ? '尚未收到' : 'Not received')}</strong>
          <span>{terminal?.reason ?? 'turn_terminal pending'}</span>
        </footer>
      </main>
    </div>
  );
}

function runtimeStateLabel(
  state: ReturnType<typeof useRuntimeTurnStore>['streamState'],
  language: AppLanguage,
) {
  const labels = language === 'zh'
    ? {
        idle: '待机',
        discovering: '能力发现',
        ready: '已就绪',
        streaming: '流式接收',
        settled: '已结束',
        error: '错误',
      }
    : {
        idle: 'Idle',
        discovering: 'Discovering',
        ready: 'Ready',
        streaming: 'Streaming',
        settled: 'Settled',
        error: 'Error',
      };
  return labels[state];
}
