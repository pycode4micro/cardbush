import {
  Check,
  Clock3,
  Edit3,
  Eye,
  Folder,
  LoaderCircle,
  MessageSquare,
  Terminal,
  X,
} from 'lucide-react';
import type { RuntimePermissionScope } from '@cardbush/bush-protocol';

import type {
  AppLanguage,
  InteractionOption,
  InteractionQuestion,
  PendingInteraction,
} from '../../types';

const permissionDecisionIds = ['allow_once', 'allow_session', 'deny'] as const;

export function PermissionRequestCard({
  language,
  interaction,
  busy,
  onChoose,
  onCancel,
}: {
  language: AppLanguage;
  interaction: PendingInteraction;
  busy: boolean;
  onChoose: (optionId: string) => void;
  onCancel: () => void;
}) {
  const details = permissionDetails(interaction, language);
  const question = permissionQuestion(interaction.questions ?? []);
  const options = normalizedPermissionOptions(question?.options ?? [], language);
  const sourceTitle = interaction.title?.trim() ?? '';
  const title = !sourceTitle || sourceTitle === 'Permission'
    ? language === 'zh' ? '需要访问权限' : 'Permission required'
    : sourceTitle === 'Subagent permission'
      ? language === 'zh' ? '子 Agent 需要权限' : sourceTitle
      : sourceTitle;

  return (
    <section
      className="interaction-dialog interaction-card permission-request-card"
      data-no-floating-input="true"
      aria-live="assertive"
    >
      <header>
        <Folder size={17} />
        <strong>{title}</strong>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          title={language === 'zh' ? '取消请求' : 'Cancel request'}
        >
          <X size={16} />
        </button>
      </header>

      <div className="permission-request-body">
        <div className="permission-target">
          <span className="permission-target-icon">
            {details.resourceKind === 'process' ? <Terminal size={17} /> : <Folder size={17} />}
          </span>
          <span className="permission-target-copy">
            <small>{language === 'zh' ? '精确目标' : 'Exact target'}</small>
            <code>{details.target || (language === 'zh' ? '未提供结构化目标' : 'Structured target unavailable')}</code>
          </span>
          {details.accessKind && (
            <span className={`permission-access ${details.accessKind}`}>
              {details.accessKind === 'write' ? <Edit3 size={13} /> : <Eye size={13} />}
              {permissionAccessLabel(details.accessKind, language)}
            </span>
          )}
        </div>

        <div className="permission-request-details">
          {details.reason && (
            <div>
              <MessageSquare size={14} />
              <span>
                <small>{language === 'zh' ? '原因' : 'Reason'}</small>
                <p>{details.reason}</p>
              </span>
            </div>
          )}
          {details.operation && (
            <div>
              <Terminal size={14} />
              <span>
                <small>{language === 'zh' ? '计划操作' : 'Planned operation'}</small>
                <p>{details.operation}</p>
              </span>
            </div>
          )}
          {details.description && (!details.target || !details.operation) && (
            <p className="permission-description">{details.description}</p>
          )}
          {details.scopeNotice && (
            <div>
              <Folder size={14} />
              <span>
                <small>{language === 'zh' ? '当前授权边界' : 'Current permission boundary'}</small>
                <p>{details.scopeNotice}</p>
              </span>
            </div>
          )}
        </div>

        <div className="permission-actions">
          {options.map((option) => (
            <button
              key={option.id}
              className={`permission-action ${permissionOptionClass(option.id)}`}
              type="button"
              disabled={busy}
              onClick={() => onChoose(option.id)}
            >
              {busy ? <LoaderCircle className="spin" size={14} /> : permissionOptionIcon(option.id)}
              <span>{option.label}</span>
              {option.description && <small>{option.description}</small>}
            </button>
          ))}
        </div>

        <p className="permission-scope-note">
          {language === 'zh'
            ? '一次授权仅供下一次匹配访问；会话授权仅在当前任务会话内有效。'
            : 'Allow once is consumed by the next matching access. Session access lasts only for this task.'}
        </p>
      </div>
    </section>
  );
}

export function isPermissionInteraction(interaction: PendingInteraction) {
  const type = interaction.type?.trim().toLowerCase() ?? '';
  const tool = interaction.toolName?.trim().toLowerCase() ?? '';
  return (
    type.includes('permission') ||
    tool.includes('permission') ||
    interaction.runtimePermission != null
  );
}

export function permissionQuestion(questions: InteractionQuestion[]) {
  return (
    questions.find((question) => question.id === 'permission') ??
    questions.find((question) => question.options.some((option) => option.id.includes('allow'))) ??
    questions[0]
  );
}

function permissionDetails(interaction: PendingInteraction, language: AppLanguage) {
  const permission = interaction.runtimePermission;
  const targets = permission?.targets ?? [];
  const primaryTarget = targets[0];
  const actions = permission?.actions ?? [];
  const accessKind = normalizeAccessKind(actions[0] ?? '');
  return {
    target: targets.map((target) => target.label || target.value).join(' · '),
    resourceKind: primaryTarget?.kind ?? '',
    accessKind,
    reason: permission?.reason || interaction.reason || '',
    operation: accessKind ? '' : actions.join(', '),
    description: interaction.description?.trim() ?? '',
    scopeNotice: permissionScopeNotice(permission?.scope, language),
  };
}

function permissionScopeNotice(
  scope: RuntimePermissionScope | undefined,
  language: AppLanguage,
) {
  if (!scope) return '';
  if (scope.mode === 'task_free' && scope.roots.length === 0) {
    return language === 'zh'
      ? '当前会话未绑定项目或任务工作区。'
      : 'No project or task workspace is bound to this session.';
  }
  return scope.roots.join(' · ');
}

function normalizedPermissionOptions(
  options: InteractionOption[],
  language: AppLanguage,
) {
  const byId = new Map(options.map((option) => [option.id.toLowerCase(), option]));
  return permissionDecisionIds.map((id) => {
    const source = byId.get(id);
    return {
      id,
      label: permissionOptionLabel(id, language),
      description:
        source?.description?.trim() || permissionOptionDescription(id, language),
    };
  });
}

function permissionOptionLabel(optionId: string, language: AppLanguage) {
  if (language === 'zh') {
    if (optionId === 'allow_session') return '本次会话';
    if (optionId === 'deny') return '拒绝';
    return '仅这一次';
  }
  if (optionId === 'allow_session') return 'This session';
  if (optionId === 'deny') return 'Deny';
  return 'Allow once';
}

function permissionOptionDescription(optionId: string, language: AppLanguage) {
  if (language === 'zh') {
    if (optionId === 'allow_session') return '当前任务会话内有效';
    if (optionId === 'deny') return '由模型自行选择其他方案';
    return '下一次匹配访问后失效';
  }
  if (optionId === 'allow_session') return 'Valid only in this task session';
  if (optionId === 'deny') return 'Let the model choose another approach';
  return 'Expires after the next matching access';
}

function permissionAccessLabel(accessKind: string, language: AppLanguage) {
  if (accessKind === 'write') {
    return language === 'zh' ? '写入' : 'Write';
  }
  return language === 'zh' ? '读取' : 'Read';
}

function permissionOptionClass(optionId: string) {
  if (optionId === 'deny') return 'deny';
  if (optionId === 'allow_session') return 'session';
  return 'allow';
}

function permissionOptionIcon(optionId: string) {
  if (optionId === 'deny') return <X size={14} />;
  if (optionId === 'allow_session') return <Clock3 size={14} />;
  return <Check size={14} />;
}

function normalizeAccessKind(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'write' || normalized.includes('write')) return 'write';
  if (normalized === 'read' || normalized.includes('read')) return 'read';
  return '';
}
