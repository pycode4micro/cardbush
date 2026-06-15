import {
  ArrowRight,
  BrainCircuit,
  BriefcaseBusiness,
  CheckCircle2,
  CircleDot,
  Clock3,
  Crown,
  FileCheck2,
  GitBranch,
  LockKeyhole,
  MessageSquareText,
  Play,
  Route,
  SendHorizontal,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  UserRound,
  UsersRound,
  Workflow,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { AppLanguage } from '../types';

type TeamRole = 'boss' | 'lead' | 'member' | 'ai';
type TeamPermission = 'owner' | 'manager' | 'contributor' | 'observer';
type TeamNodeStatus = 'ready' | 'running' | 'blocked' | 'review' | 'done';
type TeamEventVisibility = 'boss' | 'assignee' | 'team';
type TeamModule = 'brief' | 'plan' | 'members' | 'work' | 'events';

type TeamMember = {
  id: string;
  name: string;
  title: string;
  role: TeamRole;
  permission: TeamPermission;
  assistant: string;
  scope: string;
  skills: string[];
};

type TeamNode = {
  id: string;
  title: string;
  ownerId: string;
  status: TeamNodeStatus;
  visibility: TeamEventVisibility;
  summary: string;
  input: string;
  deliverable: string;
  dependsOn: string[];
  assistantThread: TeamChatMessage[];
};

type TeamChatMessage = {
  role: 'assistant' | 'member';
  text: string;
};

type TeamEvent = {
  id: string;
  time: string;
  type: 'planned' | 'assigned' | 'started' | 'blocked' | 'submitted' | 'reviewed';
  actorId: string;
  nodeId?: string;
  visibility: TeamEventVisibility;
  text: string;
};

const teamMembers: TeamMember[] = [
  {
    id: 'boss',
    name: 'Aster',
    title: 'Boss / Mission Owner',
    role: 'boss',
    permission: 'owner',
    assistant: 'Boss Assistant',
    scope: 'mission_all',
    skills: ['目标澄清', 'DAG 拆分', '风险裁剪'],
  },
  {
    id: 'product',
    name: 'Mira',
    title: 'Product Lead',
    role: 'lead',
    permission: 'manager',
    assistant: 'Product Assistant',
    scope: 'product_nodes',
    skills: ['需求边界', '验收标准', '用户路径'],
  },
  {
    id: 'frontend',
    name: 'Chen',
    title: 'Frontend Engineer',
    role: 'member',
    permission: 'contributor',
    assistant: 'Frontend Assistant',
    scope: 'assigned_nodes',
    skills: ['交互设计', '状态管理', '视觉实现'],
  },
  {
    id: 'backend',
    name: 'Rin',
    title: 'Backend Engineer',
    role: 'member',
    permission: 'contributor',
    assistant: 'Backend Assistant',
    scope: 'assigned_nodes',
    skills: ['接口契约', '权限裁剪', '事件流'],
  },
  {
    id: 'qa',
    name: 'Noah',
    title: 'QA / Reviewer',
    role: 'member',
    permission: 'contributor',
    assistant: 'QA Assistant',
    scope: 'review_nodes',
    skills: ['验收矩阵', '回归路径', '证据整理'],
  },
  {
    id: 'planner-ai',
    name: 'Planner AI',
    title: 'AI-only Router',
    role: 'ai',
    permission: 'observer',
    assistant: 'Planner Runtime',
    scope: 'planning_surface',
    skills: ['组织路由', '依赖排序', '事件推进'],
  },
];

const missionNodes: TeamNode[] = [
  {
    id: 'n1',
    title: '澄清目标与成功标准',
    ownerId: 'product',
    status: 'done',
    visibility: 'team',
    summary: '把 Boss 的目标改写成可验证的业务结果，定义不做什么。',
    input: 'Boss 原始目标、当前团队成员能力、项目约束。',
    deliverable: 'Mission Brief v1，包含目标、非目标、验收指标。',
    dependsOn: [],
    assistantThread: [
      {
        role: 'assistant',
        text: '我会先把目标拆成 outcome、scope 和 acceptance，避免后续节点各做各的。',
      },
      {
        role: 'member',
        text: '先输出一份不超过 8 条的验收标准。',
      },
    ],
  },
  {
    id: 'n2',
    title: '设计 Team Runtime 接口',
    ownerId: 'backend',
    status: 'running',
    visibility: 'assignee',
    summary: '定义 Team、Mission、Node、Event、Artifact 的最小后端契约。',
    input: 'Mission Brief v1、权限模型、DAG 节点状态定义。',
    deliverable: 'OpenAPI 草案和事件流 payload 示例。',
    dependsOn: ['n1'],
    assistantThread: [
      {
        role: 'assistant',
        text: '本节点只需要看到全局目标、自己负责的接口契约，以及上游公开的验收标准。',
      },
    ],
  },
  {
    id: 'n3',
    title: '构建成员工作区 UI',
    ownerId: 'frontend',
    status: 'running',
    visibility: 'assignee',
    summary: '让每个成员只进入自己的节点空间，与自己的 AI 助理对话。',
    input: 'Mission Brief v1、节点可见上下文、设计系统约束。',
    deliverable: 'Team 面板、DAG 节点视图、成员助理对话区。',
    dependsOn: ['n1'],
    assistantThread: [
      {
        role: 'assistant',
        text: '我会把 Boss 全局视图和成员节点视图分开，避免上下级信息混在同一个聊天流里。',
      },
    ],
  },
  {
    id: 'n4',
    title: '权限与可见性校验',
    ownerId: 'qa',
    status: 'ready',
    visibility: 'assignee',
    summary: '验证不同成员只能看到自己的节点、公开依赖和允许的事件。',
    input: '前端可见性矩阵、后端 scope 字段、示例事件。',
    deliverable: '权限测试清单和 409/403 错误场景。',
    dependsOn: ['n2', 'n3'],
    assistantThread: [
      {
        role: 'assistant',
        text: '我会按 Boss、负责人、普通成员、观察者四种视角分别走一遍。',
      },
    ],
  },
  {
    id: 'n5',
    title: '汇总结果并发起 Review',
    ownerId: 'boss',
    status: 'review',
    visibility: 'boss',
    summary: 'Boss Assistant 聚合每个节点的产出，提出接受、退回或继续拆分建议。',
    input: '所有已提交 artifact、事件流、风险清单。',
    deliverable: 'Final Brief 和下一轮行动建议。',
    dependsOn: ['n2', 'n3', 'n4'],
    assistantThread: [
      {
        role: 'assistant',
        text: '我只在 Boss 视图聚合所有节点，成员端不会看到其他人的私有讨论。',
      },
    ],
  },
];

const baseEvents: TeamEvent[] = [
  {
    id: 'e1',
    time: '09:12',
    type: 'planned',
    actorId: 'planner-ai',
    visibility: 'team',
    text: 'Planner AI 根据成员能力生成第一版 DAG。',
  },
  {
    id: 'e2',
    time: '09:16',
    type: 'assigned',
    actorId: 'boss',
    nodeId: 'n1',
    visibility: 'team',
    text: 'Boss 将目标澄清分配给 Product Lead。',
  },
  {
    id: 'e3',
    time: '09:22',
    type: 'started',
    actorId: 'backend',
    nodeId: 'n2',
    visibility: 'assignee',
    text: 'Backend Assistant 开始整理 Team Runtime 接口草案。',
  },
  {
    id: 'e4',
    time: '09:28',
    type: 'started',
    actorId: 'frontend',
    nodeId: 'n3',
    visibility: 'assignee',
    text: 'Frontend Assistant 开始构建成员工作区 UI。',
  },
  {
    id: 'e5',
    time: '09:35',
    type: 'reviewed',
    actorId: 'boss',
    nodeId: 'n5',
    visibility: 'boss',
    text: 'Boss Assistant 等待下游 artifact 后做最终汇总。',
  },
];

const statusLabel: Record<TeamNodeStatus, { zh: string; en: string }> = {
  ready: { zh: '待开始', en: 'Ready' },
  running: { zh: '进行中', en: 'Running' },
  blocked: { zh: '阻塞', en: 'Blocked' },
  review: { zh: '复核', en: 'Review' },
  done: { zh: '完成', en: 'Done' },
};

const permissionLabel: Record<TeamPermission, { zh: string; en: string }> = {
  owner: { zh: '全局 Owner', en: 'Owner' },
  manager: { zh: '管理视图', en: 'Manager' },
  contributor: { zh: '执行视图', en: 'Contributor' },
  observer: { zh: '观察者', en: 'Observer' },
};

export function TeamPanel({ language }: { language: AppLanguage }) {
  const [activeModule, setActiveModule] = useState<TeamModule>('brief');
  const [activeMemberId, setActiveMemberId] = useState('boss');
  const [activeNodeId, setActiveNodeId] = useState('n3');
  const [missionPrompt, setMissionPrompt] = useState(
    language === 'zh'
      ? '把“组织内有人但不知道谁该做什么”的任务流，变成可分配、可追踪、可复核的 Team DAG。'
      : 'Turn fuzzy team work into assignable, traceable, reviewable Team DAGs.',
  );
  const [planReady, setPlanReady] = useState(true);
  const [localEvents, setLocalEvents] = useState<TeamEvent[]>([]);
  const [nodeThreads, setNodeThreads] = useState<Record<string, TeamChatMessage[]>>({});
  const [draft, setDraft] = useState('');

  const activeMember = useMemo(
    () => teamMembers.find((member) => member.id === activeMemberId) ?? teamMembers[0],
    [activeMemberId],
  );
  const visibleNodes = useMemo(
    () => missionNodes.filter((node) => canViewNode(activeMember, node)),
    [activeMember],
  );
  const selectedNode = visibleNodes.find((node) => node.id === activeNodeId) ?? visibleNodes[0];
  const selectedOwner = selectedNode
    ? teamMembers.find((member) => member.id === selectedNode.ownerId)
    : undefined;
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEvents = useMemo(
    () =>
      [...localEvents, ...baseEvents].filter((event) =>
        canViewEvent(activeMember, event, missionNodes),
      ),
    [activeMember, localEvents],
  );
  const completedNodes = missionNodes.filter((node) => node.status === 'done').length;
  const blockedNodes = missionNodes.filter((node) => node.status === 'blocked').length;
  const hiddenNodeCount = missionNodes.length - visibleNodes.length;
  const thread = selectedNode
    ? nodeThreads[selectedNode.id] ?? selectedNode.assistantThread
    : [];
  const moduleCards = teamModuleCards({
    language,
    visibleNodeCount: visibleNodes.length,
    totalNodeCount: missionNodes.length,
    activeMember,
    selectedNode,
    eventCount: visibleEvents.length,
    planReady,
  });
  const activeCard = moduleCards.find((card) => card.id === activeModule) ?? moduleCards[0];

  function runPlanner() {
    setPlanReady(true);
    setActiveModule('plan');
    setLocalEvents((current) => [
      {
        id: `local-${Date.now()}`,
        time: 'now',
        type: 'planned',
        actorId: 'planner-ai',
        visibility: 'team',
        text:
          language === 'zh'
            ? 'Boss Assistant 已根据当前目标刷新 DAG 草案。'
            : 'Boss Assistant refreshed the DAG draft from the current objective.',
      },
      ...current,
    ]);
  }

  function selectMember(member: TeamMember) {
    setActiveMemberId(member.id);
    const firstVisible = missionNodes.find((node) => canViewNode(member, node));
    if (firstVisible) {
      setActiveNodeId(firstVisible.id);
    }
  }

  function sendNodeMessage() {
    if (!selectedNode || !draft.trim()) {
      return;
    }
    const text = draft.trim();
    setDraft('');
    setNodeThreads((current) => {
      const existing = current[selectedNode.id] ?? selectedNode.assistantThread;
      return {
        ...current,
        [selectedNode.id]: [
          ...existing,
          { role: 'member', text },
          {
            role: 'assistant',
            text:
              language === 'zh'
                ? '已记录到当前节点上下文。后端接入后，这里会进入该成员自己的 node chat stream。'
                : 'Captured in this node context. With backend support this will stream through this member node assistant.',
          },
        ],
      };
    });
  }

  return (
    <div className="feature-content team-content">
      <div className="team-shell progressive">
        <nav className="team-module-switch" aria-label="Team modules">
          {moduleCards.map((card) => (
            <button
              className={`team-module-card ${card.id === activeModule ? 'active' : ''}`}
              key={card.id}
              type="button"
              onClick={() => setActiveModule(card.id)}
            >
              <span className="team-module-card-icon">{card.icon}</span>
              <span>
                <strong>{card.title}</strong>
                <small>{card.subtitle}</small>
              </span>
              <em>{card.meta}</em>
            </button>
          ))}
        </nav>

        <section className={`team-module-panel ${activeModule}`}>
          <header className="team-module-panel-header">
            <div>
              <span>
                {activeCard.icon}
                {activeCard.eyebrow}
              </span>
              <h2>{activeCard.heading}</h2>
              <p>{activeCard.description}</p>
            </div>
            <div className="team-module-state">
              <strong>{activeMember.name}</strong>
              <small>{permissionLabel[activeMember.permission][language]}</small>
            </div>
          </header>

          {activeModule === 'brief' && (
            <BriefModule
              language={language}
              missionPrompt={missionPrompt}
              onMissionPromptChange={setMissionPrompt}
              onRunPlanner={runPlanner}
              visibleNodeCount={visibleNodes.length}
              totalNodeCount={missionNodes.length}
              completedNodes={completedNodes}
              hiddenNodeCount={hiddenNodeCount}
            />
          )}

          {activeModule === 'plan' && (
            <PlanModule
              language={language}
              activeMember={activeMember}
              hiddenNodeCount={hiddenNodeCount}
              planReady={planReady}
              selectedNode={selectedNode}
              selectedOwner={selectedOwner}
              visibleNodeIds={visibleNodeIds}
              visibleNodes={visibleNodes}
              onSelectNode={setActiveNodeId}
            />
          )}

          {activeModule === 'members' && (
            <MembersModule
              language={language}
              activeMember={activeMember}
              visibleNodes={visibleNodes}
              onSelectMember={selectMember}
            />
          )}

          {activeModule === 'work' && (
            <WorkModule
              language={language}
              activeMember={activeMember}
              draft={draft}
              selectedNode={selectedNode}
              selectedOwner={selectedOwner}
              thread={thread}
              visibleNodes={visibleNodes}
              onDraftChange={setDraft}
              onSelectNode={setActiveNodeId}
              onSend={sendNodeMessage}
            />
          )}

          {activeModule === 'events' && (
            <EventsModule
              language={language}
              blockedNodes={blockedNodes}
              completedNodes={completedNodes}
              hiddenNodeCount={hiddenNodeCount}
              selectedNode={selectedNode}
              visibleEvents={visibleEvents}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function BriefModule({
  language,
  missionPrompt,
  visibleNodeCount,
  totalNodeCount,
  completedNodes,
  hiddenNodeCount,
  onMissionPromptChange,
  onRunPlanner,
}: {
  language: AppLanguage;
  missionPrompt: string;
  visibleNodeCount: number;
  totalNodeCount: number;
  completedNodes: number;
  hiddenNodeCount: number;
  onMissionPromptChange: (value: string) => void;
  onRunPlanner: () => void;
}) {
  return (
    <div className="team-brief-grid">
      <label className="team-mission-input">
        <span>{language === 'zh' ? '任务目标' : 'Mission objective'}</span>
        <textarea
          value={missionPrompt}
          onChange={(event) => onMissionPromptChange(event.currentTarget.value)}
        />
      </label>
      <aside className="team-brief-side">
        <div className="team-command-actions">
          <button className="primary-button" type="button" onClick={onRunPlanner}>
            <Sparkles size={15} />
            {language === 'zh' ? 'AI 拆分 DAG' : 'Decompose DAG'}
          </button>
          <button className="secondary-button" type="button">
            <Play size={15} />
            {language === 'zh' ? '启动事件流' : 'Start flow'}
          </button>
        </div>
        <div className="team-brief-metrics">
          <TeamMetric
            icon={<Workflow size={16} />}
            label={language === 'zh' ? '可见节点' : 'Visible nodes'}
            value={`${visibleNodeCount}/${totalNodeCount}`}
          />
          <TeamMetric
            icon={<CheckCircle2 size={16} />}
            label={language === 'zh' ? '已完成' : 'Done'}
            value={`${completedNodes}`}
          />
          <TeamMetric
            icon={<LockKeyhole size={16} />}
            label={language === 'zh' ? '权限隐藏' : 'Hidden'}
            value={`${hiddenNodeCount}`}
          />
        </div>
        <div className="team-guide-list">
          <TeamGuide
            icon={<Crown size={14} />}
            title={language === 'zh' ? 'Boss 只管目标' : 'Boss owns intent'}
            text={
              language === 'zh'
                ? '目标、边界和验收先被写清楚，再进入组织拆分。'
                : 'Intent, scope, and acceptance are clarified before routing.'
            }
          />
          <TeamGuide
            icon={<BrainCircuit size={14} />}
            title={language === 'zh' ? 'AI 负责拆分' : 'AI plans the split'}
            text={
              language === 'zh'
                ? 'Planner 根据成员能力生成节点和依赖，Boss 可复核。'
                : 'Planner generates nodes and dependencies from member capability.'
            }
          />
          <TeamGuide
            icon={<LockKeyhole size={14} />}
            title={language === 'zh' ? '成员只看相关信息' : 'Members see scoped work'}
            text={
              language === 'zh'
                ? '节点上下文和事件由后端按 viewer 裁剪。'
                : 'Node context and events are trimmed by backend viewer scope.'
            }
          />
        </div>
      </aside>
    </div>
  );
}

function PlanModule({
  language,
  activeMember,
  hiddenNodeCount,
  planReady,
  selectedNode,
  selectedOwner,
  visibleNodeIds,
  visibleNodes,
  onSelectNode,
}: {
  language: AppLanguage;
  activeMember: TeamMember;
  hiddenNodeCount: number;
  planReady: boolean;
  selectedNode?: TeamNode;
  selectedOwner?: TeamMember;
  visibleNodeIds: Set<string>;
  visibleNodes: TeamNode[];
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <div className="team-panel-split plan">
      <section className="team-graph-surface compact">
        <header className="team-section-header">
          <span>
            <Route size={16} />
            {language === 'zh' ? 'Mission DAG' : 'Mission DAG'}
          </span>
          <em>
            {planReady
              ? language === 'zh'
                ? '草案已生成'
                : 'Generated'
              : language === 'zh'
                ? '草案'
                : 'Draft'}
          </em>
        </header>
        <div className="team-node-board compact">
          {visibleNodes.map((node) => {
            const owner = teamMembers.find((member) => member.id === node.ownerId);
            return (
              <TeamNodeCard
                activeMember={activeMember}
                isActive={node.id === selectedNode?.id}
                key={node.id}
                language={language}
                node={node}
                owner={owner}
                visibleNodeIds={visibleNodeIds}
                onClick={() => onSelectNode(node.id)}
              />
            );
          })}
        </div>
        {hiddenNodeCount > 0 && (
          <p className="team-visibility-note">
            <LockKeyhole size={14} />
            {language === 'zh'
              ? `${hiddenNodeCount} 个节点已按当前成员权限隐藏。`
              : `${hiddenNodeCount} nodes are hidden for this member perspective.`}
          </p>
        )}
      </section>
      <NodeSummaryCard language={language} node={selectedNode} owner={selectedOwner} />
    </div>
  );
}

function MembersModule({
  language,
  activeMember,
  visibleNodes,
  onSelectMember,
}: {
  language: AppLanguage;
  activeMember: TeamMember;
  visibleNodes: TeamNode[];
  onSelectMember: (member: TeamMember) => void;
}) {
  return (
    <div className="team-members-layout">
      <section className="team-roster-surface">
        <header className="team-section-header">
          <span>
            <BriefcaseBusiness size={16} />
            {language === 'zh' ? '组织成员' : 'Team members'}
          </span>
          <em>{teamMembers.length}</em>
        </header>
        <div className="team-roster-list">
          {teamMembers.map((member) => (
            <button
              className={member.id === activeMember.id ? 'active' : ''}
              key={member.id}
              type="button"
              onClick={() => onSelectMember(member)}
            >
              <span>{member.role === 'boss' ? <Crown size={15} /> : <BrainCircuit size={15} />}</span>
              <strong>{member.name}</strong>
              <small>{member.title}</small>
              <em>{member.assistant}</em>
            </button>
          ))}
        </div>
      </section>
      <section className="team-member-detail">
        <header>
          <span>{activeMember.role === 'boss' ? <Crown size={18} /> : <UserRound size={18} />}</span>
          <div>
            <strong>{activeMember.name}</strong>
            <small>{activeMember.title}</small>
          </div>
        </header>
        <div className="team-member-detail-grid">
          <InfoChip
            icon={<ShieldCheck size={14} />}
            label={language === 'zh' ? '权限' : 'Permission'}
            value={permissionLabel[activeMember.permission][language]}
          />
          <InfoChip
            icon={<MessageSquareText size={14} />}
            label={language === 'zh' ? '助理' : 'Assistant'}
            value={activeMember.assistant}
          />
          <InfoChip
            icon={<LockKeyhole size={14} />}
            label={language === 'zh' ? '范围' : 'Scope'}
            value={activeMember.scope}
          />
          <InfoChip
            icon={<Workflow size={14} />}
            label={language === 'zh' ? '可见节点' : 'Visible nodes'}
            value={`${visibleNodes.length}`}
          />
        </div>
        <div className="team-skill-list">
          {activeMember.skills.map((skill) => (
            <span key={skill}>{skill}</span>
          ))}
        </div>
      </section>
    </div>
  );
}

function WorkModule({
  language,
  activeMember,
  draft,
  selectedNode,
  selectedOwner,
  thread,
  visibleNodes,
  onDraftChange,
  onSelectNode,
  onSend,
}: {
  language: AppLanguage;
  activeMember: TeamMember;
  draft: string;
  selectedNode?: TeamNode;
  selectedOwner?: TeamMember;
  thread: TeamChatMessage[];
  visibleNodes: TeamNode[];
  onDraftChange: (value: string) => void;
  onSelectNode: (nodeId: string) => void;
  onSend: () => void;
}) {
  return (
    <div className="team-work-layout">
      <aside className="team-node-picker">
        {visibleNodes.map((node) => (
          <button
            className={node.id === selectedNode?.id ? 'active' : ''}
            key={node.id}
            type="button"
            onClick={() => onSelectNode(node.id)}
          >
            <TeamStatus status={node.status} language={language} />
            <span>{node.title}</span>
          </button>
        ))}
      </aside>
      <section className="team-node-workspace">
        {selectedNode ? (
          <>
            <header className="team-node-workspace-header">
              <div>
                <span>
                  <MessageSquareText size={16} />
                  {selectedOwner?.assistant ?? 'Node Assistant'}
                </span>
                <h3>{selectedNode.title}</h3>
              </div>
              <TeamStatus status={selectedNode.status} language={language} />
            </header>
            <div className="team-scope-grid">
              <InfoChip
                icon={<ShieldCheck size={14} />}
                label={language === 'zh' ? '可见范围' : 'Scope'}
                value={selectedNode.visibility}
              />
              <InfoChip
                icon={<UserRound size={14} />}
                label={language === 'zh' ? '负责人' : 'Owner'}
                value={selectedOwner?.name ?? 'AI'}
              />
              <InfoChip
                icon={<FileCheck2 size={14} />}
                label={language === 'zh' ? '交付物' : 'Deliverable'}
                value={selectedNode.deliverable}
              />
            </div>
            <div className="team-context-panel">
              <strong>{language === 'zh' ? '允许进入本节点的上下文' : 'Context allowed into this node'}</strong>
              <p>{selectedNode.input}</p>
            </div>
            <div className="team-node-thread">
              {thread.map((message, index) => (
                <article className={message.role} key={`${message.role}-${index}`}>
                  <span>{message.role === 'assistant' ? selectedOwner?.assistant : activeMember.name}</span>
                  <p>{message.text}</p>
                </article>
              ))}
            </div>
            <div className="team-node-chatbox">
              <input
                value={draft}
                onChange={(event) => onDraftChange(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onSend();
                  }
                }}
                placeholder={
                  language === 'zh'
                    ? '和本节点助理讨论，不会混入其他成员私聊'
                    : 'Discuss with this node assistant only'
                }
              />
              <button type="button" onClick={onSend}>
                <SendHorizontal size={15} />
              </button>
            </div>
          </>
        ) : (
          <div className="team-empty-node">
            <LockKeyhole size={22} />
            <strong>{language === 'zh' ? '没有可见节点' : 'No visible nodes'}</strong>
            <p>
              {language === 'zh'
                ? '当前成员只会看到后端裁剪后允许进入的节点。'
                : 'This member only sees nodes allowed by backend visibility trimming.'}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function EventsModule({
  language,
  blockedNodes,
  completedNodes,
  hiddenNodeCount,
  selectedNode,
  visibleEvents,
}: {
  language: AppLanguage;
  blockedNodes: number;
  completedNodes: number;
  hiddenNodeCount: number;
  selectedNode?: TeamNode;
  visibleEvents: TeamEvent[];
}) {
  return (
    <div className="team-review-layout">
      <section className="team-event-surface">
        <header className="team-section-header">
          <span>
            <GitBranch size={16} />
            {language === 'zh' ? '事件流' : 'Event stream'}
          </span>
          <em>{visibleEvents.length}</em>
        </header>
        <div className="team-event-list">
          {visibleEvents.map((event) => (
            <article className={event.visibility} key={event.id}>
              <Clock3 size={14} />
              <div>
                <span>
                  {event.time}
                  <ArrowRight size={12} />
                  {event.type}
                </span>
                <p>{event.text}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="team-review-card">
        <header>
          <FileCheck2 size={18} />
          <div>
            <strong>{language === 'zh' ? '复核快照' : 'Review snapshot'}</strong>
            <small>{language === 'zh' ? '只显示当前视角可见证据' : 'Only visible evidence is shown'}</small>
          </div>
        </header>
        <div className="team-brief-metrics">
          <TeamMetric
            icon={<CheckCircle2 size={16} />}
            label={language === 'zh' ? '完成' : 'Done'}
            value={`${completedNodes}`}
          />
          <TeamMetric
            icon={<TriangleAlert size={16} />}
            label={language === 'zh' ? '阻塞' : 'Blocked'}
            value={`${blockedNodes}`}
          />
          <TeamMetric
            icon={<LockKeyhole size={16} />}
            label={language === 'zh' ? '隐藏' : 'Hidden'}
            value={`${hiddenNodeCount}`}
          />
        </div>
        <div className="team-context-panel">
          <strong>{language === 'zh' ? '当前关注节点' : 'Focused node'}</strong>
          <p>{selectedNode?.deliverable ?? (language === 'zh' ? '暂无节点' : 'No node')}</p>
        </div>
        <div className="team-review-actions">
          <button className="primary-button" type="button">
            <CheckCircle2 size={15} />
            {language === 'zh' ? '接受产出' : 'Accept'}
          </button>
          <button className="secondary-button" type="button">
            <Workflow size={15} />
            {language === 'zh' ? '继续拆分' : 'Split more'}
          </button>
        </div>
      </section>
    </div>
  );
}

function TeamNodeCard({
  activeMember,
  isActive,
  language,
  node,
  owner,
  visibleNodeIds,
  onClick,
}: {
  activeMember: TeamMember;
  isActive: boolean;
  language: AppLanguage;
  node: TeamNode;
  owner?: TeamMember;
  visibleNodeIds: Set<string>;
  onClick: () => void;
}) {
  return (
    <button
      className={`team-node-card ${node.status} ${isActive ? 'active' : ''}`}
      type="button"
      onClick={onClick}
    >
      <header>
        <span>{node.id.toUpperCase()}</span>
        <TeamStatus status={node.status} language={language} />
      </header>
      <strong>{node.title}</strong>
      <p>{node.summary}</p>
      <footer>
        <small>{owner?.name ?? 'AI'}</small>
        {node.dependsOn.length > 0 && (
          <span>
            {node.dependsOn
              .filter((id) => visibleNodeIds.has(id) || activeMember.role === 'boss')
              .join(' -> ')}
          </span>
        )}
      </footer>
    </button>
  );
}

function NodeSummaryCard({
  language,
  node,
  owner,
}: {
  language: AppLanguage;
  node?: TeamNode;
  owner?: TeamMember;
}) {
  if (!node) {
    return (
      <aside className="team-node-summary-card empty">
        <LockKeyhole size={22} />
        <strong>{language === 'zh' ? '没有可见节点' : 'No visible node'}</strong>
      </aside>
    );
  }
  return (
    <aside className="team-node-summary-card">
      <header>
        <span>
          <MessageSquareText size={16} />
          {owner?.assistant ?? 'Node Assistant'}
        </span>
        <TeamStatus status={node.status} language={language} />
      </header>
      <h3>{node.title}</h3>
      <p>{node.summary}</p>
      <div className="team-scope-grid">
        <InfoChip
          icon={<ShieldCheck size={14} />}
          label={language === 'zh' ? '可见范围' : 'Scope'}
          value={node.visibility}
        />
        <InfoChip
          icon={<UserRound size={14} />}
          label={language === 'zh' ? '负责人' : 'Owner'}
          value={owner?.name ?? 'AI'}
        />
      </div>
      <div className="team-context-panel">
        <strong>{language === 'zh' ? '交付物' : 'Deliverable'}</strong>
        <p>{node.deliverable}</p>
      </div>
    </aside>
  );
}

function TeamMetric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <article className="team-metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function TeamGuide({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <article className="team-guide-item">
      {icon}
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
    </article>
  );
}

function TeamStatus({
  status,
  language,
}: {
  status: TeamNodeStatus;
  language: AppLanguage;
}) {
  return (
    <span className={`team-status ${status}`}>
      <CircleDot size={12} />
      {statusLabel[status][language]}
    </span>
  );
}

function InfoChip({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <span className="team-info-chip">
      {icon}
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

function teamModuleCards({
  language,
  visibleNodeCount,
  totalNodeCount,
  activeMember,
  selectedNode,
  eventCount,
  planReady,
}: {
  language: AppLanguage;
  visibleNodeCount: number;
  totalNodeCount: number;
  activeMember: TeamMember;
  selectedNode?: TeamNode;
  eventCount: number;
  planReady: boolean;
}): Array<{
  id: TeamModule;
  icon: ReactNode;
  title: string;
  subtitle: string;
  meta: string;
  eyebrow: string;
  heading: string;
  description: string;
}> {
  return [
    {
      id: 'brief',
      icon: <Crown size={16} />,
      title: language === 'zh' ? '任务' : 'Brief',
      subtitle: language === 'zh' ? 'Boss 输入' : 'Boss input',
      meta: planReady ? (language === 'zh' ? '可拆分' : 'Ready') : 'Draft',
      eyebrow: language === 'zh' ? 'Mission Brief' : 'Mission Brief',
      heading: language === 'zh' ? '先把目标说清楚' : 'Clarify the mission first',
      description:
        language === 'zh'
          ? 'Boss 只需要描述目标，AI 再把它变成可分配、可追踪的组织任务。'
          : 'The boss describes intent; AI turns it into assignable and traceable work.',
    },
    {
      id: 'plan',
      icon: <Route size={16} />,
      title: language === 'zh' ? 'DAG' : 'DAG',
      subtitle: language === 'zh' ? '任务图谱' : 'Mission graph',
      meta: `${visibleNodeCount}/${totalNodeCount}`,
      eyebrow: language === 'zh' ? 'Planning' : 'Planning',
      heading: language === 'zh' ? '查看任务节点和依赖' : 'Review nodes and dependencies',
      description:
        language === 'zh'
          ? '这里只处理 DAG 草案、依赖和节点摘要，不混入成员私聊。'
          : 'This module only handles the graph, dependencies, and node summaries.',
    },
    {
      id: 'members',
      icon: <UsersRound size={16} />,
      title: language === 'zh' ? '成员' : 'Members',
      subtitle: language === 'zh' ? '视角/权限' : 'View / roles',
      meta: activeMember.name,
      eyebrow: language === 'zh' ? 'Organization' : 'Organization',
      heading: language === 'zh' ? '选择一个成员视角' : 'Choose a member perspective',
      description:
        language === 'zh'
          ? '不同成员看到不同节点、上下文和事件；前端只展示裁剪后的视图。'
          : 'Different members see different nodes, context, and events.',
    },
    {
      id: 'work',
      icon: <MessageSquareText size={16} />,
      title: language === 'zh' ? '执行' : 'Work',
      subtitle: language === 'zh' ? '节点助理' : 'Node assistant',
      meta: selectedNode ? statusLabel[selectedNode.status][language] : '-',
      eyebrow: language === 'zh' ? 'Node Workspace' : 'Node Workspace',
      heading: language === 'zh' ? '进入当前节点工作区' : 'Enter the node workspace',
      description:
        language === 'zh'
          ? '每个节点有自己的助理和上下文，不和 Boss 全局对话混在一起。'
          : 'Each node has its own assistant and scoped context.',
    },
    {
      id: 'events',
      icon: <GitBranch size={16} />,
      title: language === 'zh' ? '复核' : 'Review',
      subtitle: language === 'zh' ? '事件/产出' : 'Events / outputs',
      meta: `${eventCount}`,
      eyebrow: language === 'zh' ? 'Review' : 'Review',
      heading: language === 'zh' ? '用事件和产出做收口' : 'Close with events and outputs',
      description:
        language === 'zh'
          ? '只在这里看事件流、交付物和复核动作，避免干扰日常执行。'
          : 'Events, artifacts, and review actions live here to avoid distracting work.',
    },
  ];
}

function canViewNode(member: TeamMember, node: TeamNode) {
  if (member.role === 'boss') {
    return true;
  }
  if (node.visibility === 'team') {
    return true;
  }
  if (node.ownerId === member.id) {
    return true;
  }
  return node.dependsOn.some((dependencyId) => {
    const dependency = missionNodes.find((item) => item.id === dependencyId);
    return dependency?.ownerId === member.id && dependency.visibility !== 'boss';
  });
}

function canViewEvent(member: TeamMember, event: TeamEvent, nodes: TeamNode[]) {
  if (member.role === 'boss') {
    return true;
  }
  if (event.visibility === 'team') {
    return true;
  }
  const node = event.nodeId ? nodes.find((item) => item.id === event.nodeId) : undefined;
  if (event.visibility === 'assignee') {
    return node?.ownerId === member.id || event.actorId === member.id;
  }
  return false;
}
