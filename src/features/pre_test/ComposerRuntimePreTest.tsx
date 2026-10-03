import { useMemo, useRef, useState, type CSSProperties } from 'react';

import type { ExperimentalGoal } from '../../backend/api';
import type { AppLanguage, PendingInteraction, TaskPlanSnapshot } from '../../types';
import {
  ShadowTemporaryChat,
  type ShadowChatEntry,
} from '../chat/ShadowTemporaryChat';
import {
  Composer,
  ComposerRuntimeRail,
  type ThinkingNotice,
  type ComposerRuntimeRailHandle,
} from '../composer';
import { TurnRuntimeDetails } from '../chat/TurnRuntimeDetails';
import { AssistantThinkingDetail } from '../chatMessages/AssistantThinkingProcessLine';
import { reorderScopedQueue } from '../composer/queueOrdering';
import { PermissionRequestCard } from '../interactions/PermissionRequestCard';
import type { ConversationChangeSummary } from '../tools';

type RuntimeFixture = 'processing' | 'thinking' | 'changes' | 'shadow' | 'combined' | 'queue' | 'permission';

const thinkingFixture: ThinkingNotice = {
  id: 'pre-test-thinking',
  turnId: 'pre-test-turn',
  preview: '正在比较现有布局与输入框边界，定位状态区的挂载层级。',
  content:
    '正在检查输入框、运行状态和排队区域的层级关系。\n\n思考入口留在会话末尾，只有用户主动展开时才显示完整内容。',
  createdAt: new Date().toISOString(),
};

const shadowFixture: ShadowChatEntry = {
  id: 'pre-test-shadow',
  role: 'assistant',
  content: '验证节点可以提前并行，但会多一次上下文同步。是否采用并行方案？',
  createdAt: new Date().toISOString(),
};

const changeSummaryFixture: ConversationChangeSummary = {
  fileCount: 3,
  additions: 99,
  deletions: 27,
};

const taskPlanFixture: TaskPlanSnapshot = {
  protocol: 'bush.task_plan.v1',
  planId: 'pre-test-plan',
  sessionId: 'pre-test-session',
  explanation: '按事件顺序保留本轮文本与工具执行。',
  active: true,
  nodes: [
    { id: 'plan-1', step: '确认活动回合事件结构', status: 'completed' },
    { id: 'plan-2', step: '保留中间 assistant 与工具结果', status: 'in_progress' },
    { id: 'plan-3', step: '终轮后归档过程记录', status: 'pending' },
  ],
};

const goalFixture: ExperimentalGoal = {
  protocol: 'bush.goal.v1',
  goalId: 'pre-test-goal',
  sessionId: 'pre-test-session',
  objective: '修复 loop 过程覆盖并保持完整执行顺序',
  status: 'active',
  statusReason: '',
  consumedTokens: 4200,
  revision: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const permissionFixture: PendingInteraction = {
  id: 'pre-test-path-permission',
  type: 'path_permission_request',
  sessionId: 'pre-test-session',
  turnId: 'pre-test-turn',
  title: '需要路径权限',
  reason: '需要将最终验收报告写入桌面。',
  description: '模型请求向工作区外写入一份发布验收报告。',
  toolName: 'request_permission',
  runtimePermission: {
    reason: '需要将最终验收报告写入桌面。',
    actions: ['write'],
    targets: [{
      kind: 'filesystem_path',
      value: 'C:\\Users\\fixture\\Desktop\\release-report.md',
    }],
    requestedCapabilityIds: ['write:C:\\Users\\fixture\\Desktop\\release-report.md'],
    scope: { mode: 'task_free', roots: ['C:\\workspace'] },
  },
  questions: [{
    id: 'permission',
    label: '权限选择',
    question: '是否允许此次写入？',
    options: [
      { id: 'allow_once', label: '仅这一次' },
      { id: 'allow_session', label: '本次会话' },
      { id: 'deny', label: '拒绝' },
    ],
  }],
  raw: {
    interaction_id: 'pre-test-path-permission',
    type: 'path_permission_request',
  },
};

export function isComposerRuntimePreTestEnabled() {
  const query = new URLSearchParams(window.location.search).get('pre_test');
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('pre_test');
  return query === 'composer-runtime' ||
    hash === 'composer-runtime' ||
    window.localStorage.getItem('cardbush_pre_test') === 'composer-runtime';
}

export function ComposerRuntimePreTest({ language }: { language: AppLanguage }) {
  const [fixture, setFixture] = useState<RuntimeFixture>('combined');
  const [draft, setDraft] = useState('');
  const [shadowDraft, setShadowDraft] = useState('');
  const [shadowEntries, setShadowEntries] = useState<ShadowChatEntry[]>([]);
  const [shadowOpen, setShadowOpen] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState([
    { id: 'pre-test-queue-1', text: '补充移动端状态条的窄屏验收。', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'pre-test-queue-2', text: '核对第二条排队消息的顺序。', createdAt: '2026-01-01T00:00:01.000Z' },
    { id: 'pre-test-queue-3', text: '完成后运行队列回归测试。', createdAt: '2026-01-01T00:00:02.000Z' },
  ]);
  const runtimeRailRef = useRef<ComposerRuntimeRailHandle>(null);
  const showProcessing = fixture === 'processing' || fixture === 'combined';
  const showThinking = fixture === 'thinking' || fixture === 'combined';
  const showChanges = fixture === 'changes' || fixture === 'combined';
  const showQueue = fixture === 'queue' || fixture === 'combined';
  const fixtureOptions = useMemo<Array<{ id: RuntimeFixture; label: string }>>(
    () => [
      { id: 'processing', label: language === 'zh' ? '处理中' : 'Working' },
      { id: 'thinking', label: 'Thinking' },
      { id: 'changes', label: language === 'zh' ? '文件更改' : 'Changes' },
      { id: 'shadow', label: 'Shadow' },
      { id: 'queue', label: language === 'zh' ? '排队' : 'Queue' },
      { id: 'permission', label: language === 'zh' ? '权限请求' : 'Permission' },
      { id: 'combined', label: language === 'zh' ? '组合状态' : 'Combined' },
    ],
    [language],
  );
  const style = {
    '--shadow-accent': '#a8d5b5',
  } as CSSProperties;

  return (
    <div className="chat-panel composer-runtime-pre-test" style={style}>
      <header className="composer-runtime-pre-test-header">
        <span>
          <strong>{language === 'zh' ? '输入区运行状态 · Pre Test' : 'Composer runtime · Pre Test'}</strong>
          <small>{language === 'zh' ? '本地占位数据，不连接运行服务' : 'Local fixtures, no Runtime required'}</small>
        </span>
        <nav aria-label="Runtime fixture">
          {fixtureOptions.map((option) => (
            <button
              className={fixture === option.id ? 'active' : ''}
              key={option.id}
              type="button"
              onClick={() => {
                setFixture(option.id);
                setShadowOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="composer-runtime-pre-test-stage">
        <div className="composer-runtime-pre-test-copy">
          <small>{language === 'zh' ? '运行中的会话' : 'Active conversation'}</small>
          <h2>{language === 'zh' ? '运行状态归入会话，输入区只保留引导队列。' : 'Runtime progress stays in the conversation; the composer shows queued guidance.'}</h2>
          <p>{language === 'zh' ? '思考、计划和目标跟随当前回合；排队消息单独管理。' : 'Thinking, plans and goals stay with the current turn; queued messages are managed separately.'}</p>
        </div>
        <div className="composer-runtime-pre-test-dock runtime-attached">
          {fixture === 'permission' ? (
            <div className="composer-runtime-pre-test-permission">
              <PermissionRequestCard
                language={language}
                interaction={permissionFixture}
                busy={false}
                onChoose={() => setFixture('processing')}
                onCancel={() => setFixture('processing')}
              />
            </div>
          ) : (
            <>
              {showThinking && <AssistantThinkingDetail language={language} model="" notice={thinkingFixture} />}
              <TurnRuntimeDetails
                language={language}
                running={fixture !== 'queue'}
                taskPlan={showProcessing ? taskPlanFixture : undefined}
                goal={showProcessing ? goalFixture : null}
                goalRounds={showProcessing ? [
                  {
                    goalId: goalFixture.goalId,
                    sessionId: goalFixture.sessionId,
                    decision: 'continue',
                    status: 'active',
                    reason: '仍需验证第二轮工具返回后的文本是否保留。',
                  },
                ] : []}
                changeSummary={showChanges ? changeSummaryFixture : null}
                onOpenChangeReview={() => undefined}
              />
              <ComposerRuntimeRail
                ref={runtimeRailRef}
                language={language}
                queuedMessageCount={showQueue ? queuedMessages.length : 0}
                queuedMessagePreview={showQueue ? queuedMessages[0]?.text ?? '' : ''}
                queuedMessages={showQueue ? queuedMessages : []}
                onEditQueuedMessage={(item) => {
                  setDraft(item.text);
                  setQueuedMessages((current) => current.filter((queued) => queued.id !== item.id));
                }}
                onGuideQueuedMessage={async (queuedId) => {
                  setQueuedMessages((current) => current.filter((queued) => queued.id !== queuedId));
                }}
                onRemoveQueuedMessage={(queuedId) => {
                  setQueuedMessages((current) => current.filter((queued) => queued.id !== queuedId));
                }}
                onReorderQueuedMessage={(queuedId, targetQueuedId) => {
                  setQueuedMessages((current) => reorderScopedQueue(
                    current,
                    queuedId,
                    targetQueuedId,
                    (item) => item.id,
                    () => 'pre-test',
                  ));
                }}
              />
              {shadowOpen && (
                <ShadowTemporaryChat
                  language={language}
                  agentName="Shadow Agent"
                  entries={shadowEntries}
                  busy={false}
                  open={shadowOpen}
                  accentColor="#73d7cf"
                  onClose={() => setShadowOpen(false)}
                />
              )}
              <Composer
                compact
                language={language}
                draft={shadowOpen ? shadowDraft : draft}
                onDraftChange={shadowOpen ? setShadowDraft : setDraft}
                sending={!shadowOpen}
                goalAvailable
                queuedMessageCount={showQueue ? queuedMessages.length : 0}
                onShowQueue={() => runtimeRailRef.current?.showQueue()}
                queuedMessagePreview=""
                queuedMessages={[]}
                selectedModel="pre-test-glm"
                availableModels={[{
                  id: 'pre-test-glm',
                  provider: 'zhipu',
                  modelName: 'glm-5.2',
                  apiKey: '',
                  baseUrl: '',
                }]}
                referencePlanAvailable
                referencePlanMode="off"
                permissionMode="all_free"
                subagentPermissionRouting="parent"
                reasoningLevelAvailable
                reasoningLevel="max"
                reasoningLevels={['none', 'low', 'medium', 'high', 'xhigh', 'max']}
                onModelChange={() => undefined}
                onReferencePlanModeChange={() => undefined}
                onPermissionModeChange={() => undefined}
                onSubagentPermissionRoutingChange={() => undefined}
                onReasoningLevelChange={() => undefined}
                onSend={async (text) => {
                  if (!shadowOpen) return;
                  const reply = text.trim();
                  if (!reply) return;
                  setShadowEntries((current) => [
                    ...current,
                    {
                      id: crypto.randomUUID(),
                      role: 'user',
                      content: reply,
                      createdAt: new Date().toISOString(),
                    },
                    {
                      id: crypto.randomUUID(),
                      role: 'assistant',
                      content: '我会沿用主会话的只读上下文继续分析，不会改写主执行链。',
                      createdAt: new Date().toISOString(),
                    },
                  ]);
                  setShadowDraft('');
                }}
                onCancel={async () => undefined}
                shadowActive={shadowOpen}
                shadowAvailable
                shadowAgentName="Shadow Agent"
                onToggleShadow={() => {
                  setShadowOpen((current) => {
                    const next = !current;
                    if (next && shadowEntries.length === 0) {
                      setShadowEntries([shadowFixture]);
                    }
                    return next;
                  });
                }}
                contextWindow={{
                  usedTokens: 38_420,
                  maxTokens: 128_000,
                  remainingTokens: 89_580,
                }}
                disabledSkillNames={new Set()}
                onConfigureModels={() => undefined}
                onToggleSkill={() => undefined}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
