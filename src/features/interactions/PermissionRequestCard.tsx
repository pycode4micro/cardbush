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
  const details = permissionDetails(interaction);
  const question = permissionQuestion(interaction.questions ?? []);
  const options = normalizedPermissionOptions(question?.options ?? [], language);
  const title = interaction.title || (language === 'zh' ? '需要访问权限' : 'Permission required');

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
            <code>{details.target || (language === 'zh' ? '后端未提供结构化目标' : 'Structured target unavailable')}</code>
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
            ? '一次授权仅供下一次匹配访问；会话授权也只在当前后端会话内有效。'
            : 'Allow once is consumed by the next matching access. Session access lasts only for this backend session.'}
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
    interaction.permissionPreview != null
  );
}

export function permissionQuestion(questions: InteractionQuestion[]) {
  return (
    questions.find((question) => question.id === 'permission') ??
    questions.find((question) => question.options.some((option) => option.id.includes('allow'))) ??
    questions[0]
  );
}

function permissionDetails(interaction: PendingInteraction) {
  const raw = interaction.raw;
  const preview = interaction.permissionPreview ?? {};
  const permission = asRecord(
    preview.permission ??
      raw.permission ??
      raw.permission_request ??
      raw.permissionRequest,
  );
  const parameters = Array.isArray(preview.parameters)
    ? preview.parameters.map(asRecord)
    : [];
  const target = firstText(
    permission.path,
    permission.target,
    preview.path,
    preview.target,
    raw.path,
    raw.target,
    parameterValue(parameters, ['path', 'target', 'process']),
  );
  const resourceKind = firstText(
    permission.resource_kind,
    permission.resourceKind,
    preview.resource_kind,
    preview.resourceKind,
    raw.resource_kind,
    raw.resourceKind,
    target.startsWith('process://') ? 'process' : target ? 'path' : '',
  );
  const accessKind = normalizeAccessKind(firstText(
    permission.access_kind,
    permission.accessKind,
    permission.access,
    preview.access_kind,
    preview.accessKind,
    preview.access,
    raw.access_kind,
    raw.accessKind,
    raw.access,
    parameterValue(parameters, ['access_kind', 'access']),
  ));
  return {
    target,
    resourceKind,
    accessKind,
    reason: firstText(permission.reason, preview.reason, raw.reason, interaction.reason),
    operation: firstText(
      permission.operation,
      preview.operation,
      preview.planned_operation,
      preview.plannedOperation,
      raw.operation,
      raw.planned_operation,
      raw.plannedOperation,
      parameterValue(parameters, ['operation', 'action', 'command']),
    ),
    description: firstText(interaction.description, interaction.message),
  };
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
    if (optionId === 'allow_session') return '当前后端会话内有效';
    if (optionId === 'deny') return '由模型自行选择其他方案';
    return '下一次匹配访问后失效';
  }
  if (optionId === 'allow_session') return 'Valid only in this backend session';
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

function parameterValue(
  parameters: Record<string, unknown>[],
  names: string[],
) {
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  const parameter = parameters.find((item) =>
    normalizedNames.has(String(item.name ?? item.key ?? '').trim().toLowerCase()),
  );
  return parameter?.preview ?? parameter?.value;
}

function normalizeAccessKind(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'write' || normalized.includes('write')) return 'write';
  if (normalized === 'read' || normalized.includes('read')) return 'read';
  return '';
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}
