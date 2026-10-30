import { uiText } from '../../i18n';
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
  error,
  onChoose,
  onCancel,
}: {
  language: AppLanguage;
  interaction: PendingInteraction;
  busy: boolean;
  error?: string;
  onChoose: (optionId: string) => void;
  onCancel: () => void;
}) {
  const details = permissionDetails(interaction, language);
  const question = permissionQuestion(interaction.questions ?? []);
  const options = normalizedPermissionOptions(question?.options ?? [], language);
  const sourceTitle = interaction.title?.trim() ?? '';
  const runtimePermission = interaction.raw.protocol === 'bush.runtime_permission_answer.v1';
  const fromSubagent = Boolean(interaction.raw.subagentTaskId ||
    interaction.raw.sourceSessionId && interaction.raw.sourceSessionId !== interaction.sessionId);
  const title = runtimePermission
    ? uiText(language)(fromSubagent ? 'permission.subagentTitle' : 'permissionRequestCard.approvalRequired')
    : !sourceTitle || sourceTitle === 'Permission'
    ? uiText(language)('permissionRequestCard.approvalRequired')
    : sourceTitle === 'Subagent permission'
      ? uiText(language)('permission.subagentTitle')
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
          title={uiText(language)('permissionRequestCard.cancelRequest')}
        >
          <X size={16} />
        </button>
      </header>

      <div className="permission-request-body">
        {error && <p className="permission-request-error" role="alert">{error}</p>}
        {interaction.raw.permissionEscalationReason === 'remote_policy_requires_human' && (
          <p className="permission-description">{uiText(language)('permissionRequestCard.remotePolicyRequiresHuman')}</p>
        )}
        <div className="permission-target">
          <span className="permission-target-icon">
            {details.resourceKind === 'process' ? <Terminal size={17} /> : <Folder size={17} />}
          </span>
          <span className="permission-target-copy">
            <small>{uiText(language)('permissionRequestCard.exactTarget')}</small>
            <code>{details.target || (uiText(language)('permissionRequestCard.structuredTargetUnavailable'))}</code>
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
                <small>{uiText(language)('permissionRequestCard.reason')}</small>
                <p>{details.reason}</p>
              </span>
            </div>
          )}
          {details.operation && (
            <div>
              <Terminal size={14} />
              <span>
                <small>{uiText(language)('permissionRequestCard.plannedOperation')}</small>
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
                <small>{uiText(language)('permissionRequestCard.currentPermissionBoundary')}</small>
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
          {uiText(language)('permissionRequestCard.allowOnceAppliesToThisRequestSession')}
        </p>
      </div>
    </section>
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
    target: targets.map((target) => target.label || target.value).join('\n'),
    resourceKind: targets.some(target => target.kind === 'process') ? 'process' : primaryTarget?.kind ?? '',
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
    return uiText(language)('permissionRequestCard.noProjectOrTaskWorkspaceIsBound');
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
  const labels = { allow_session: 'permission.this_session', deny: 'mcpAppPanel.deny', allow_once: 'permission.allow_once' } as const;
  return uiText(language)(labels[optionId as keyof typeof labels] ?? labels.allow_once);
}

function permissionOptionDescription(optionId: string, language: AppLanguage) {
  const labels = { allow_session: 'permission.valid_only_in_this_task_session', deny: 'permission.reject_this_action_and_seek_a_safer', allow_once: 'permission.approve_this_request_only' } as const;
  return uiText(language)(labels[optionId as keyof typeof labels] ?? labels.allow_once);
}

function permissionAccessLabel(accessKind: string, language: AppLanguage) {
  if (accessKind === 'write') {
    return uiText(language)('permissionRequestCard.write');
  }
  return uiText(language)('permissionRequestCard.read');
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
