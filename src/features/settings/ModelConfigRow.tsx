import { useEffect, useState } from 'react';
import { Check, CheckCircle2, ChevronDown, Trash2 } from 'lucide-react';
import { DEFAULT_MAX_CONTEXT_TOKENS as defaultMaxContextTokens } from '@cardbush/bush-product-agent';
import type { AppLanguage, ManagedModelConfig } from '../../types';

export function ModelConfigRow({
  config,
  language,
  selected,
  onUse,
  onDelete,
  onSaveContextTokens,
  onSaveCompletionTokens,
  disabled = false,
  onEdit,
  expanded,
  defaultSelection = false,
}: {
  config: ManagedModelConfig;
  language: AppLanguage;
  selected: boolean;
  onUse: () => void;
  onDelete: () => void;
  onSaveContextTokens: (value: string) => void;
  onSaveCompletionTokens: (value: string) => void;
  disabled?: boolean;
  onEdit?: () => void;
  expanded?: boolean;
  defaultSelection?: boolean;
}) {
  const [contextDraft, setContextDraft] = useState(
    contextTokenDraftValue(config.maxContextTokens),
  );
  const savedContextDraft = contextTokenDraftValue(config.maxContextTokens);
  const trimmedContextDraft = contextDraft.trim();
  const hasInvalidContext =
    trimmedContextDraft.length > 0 && !normalizeMaxContextTokens(trimmedContextDraft);
  const contextDraftChanged = contextDraft !== savedContextDraft;
  const [completionDraft, setCompletionDraft] = useState(
    completionTokenDraftValue(config.maxCompletionTokens),
  );
  const savedCompletionDraft = completionTokenDraftValue(
    config.maxCompletionTokens,
  );
  const trimmedCompletionDraft = completionDraft.trim();
  const hasInvalidCompletion =
    trimmedCompletionDraft.length > 0 &&
    !normalizeMaxCompletionTokens(trimmedCompletionDraft);
  const completionDraftChanged = completionDraft !== savedCompletionDraft;

  useEffect(() => {
    setContextDraft(savedContextDraft);
  }, [savedContextDraft]);

  useEffect(() => {
    setCompletionDraft(savedCompletionDraft);
  }, [savedCompletionDraft]);

  return (
    <div className="model-row">
      <div className="model-row-summary">
        {onEdit ? <button type="button" className="model-row-disclosure" disabled={disabled} aria-expanded={expanded} aria-label={language === 'zh' ? `编辑 ${config.modelName}` : `Edit ${config.modelName}`} onClick={onEdit}>
          <strong title={config.modelName}>{config.modelName}</strong><ChevronDown size={14}/>
        </button> : <strong title={config.modelName}>{config.modelName}</strong>}
        <span>
          {config.baseUrl || (language === 'zh' ? '默认服务地址' : 'Default endpoint')}
          {' · '}
          {config.apiKey || config.hasApiKey
            ? language === 'zh' ? '凭证已保存' : 'Credential saved'
            : language === 'zh' ? '未设置凭证' : 'No credential'}
        </span>
      </div>
      <label className="model-context-editor">
        <span>{language === 'zh' ? '上下文' : 'Context'}</span>
        <div className="model-context-controls">
          <input
            aria-label={
              language === 'zh'
                ? `${config.modelName} 最大上下文 token`
                : `${config.modelName} max context tokens`
            }
            inputMode="numeric"
            disabled={disabled || expanded}
            min={1}
            placeholder={language === 'zh' ? '默认' : 'default'}
            type="number"
            value={contextDraft}
            onChange={(event) => setContextDraft(event.currentTarget.value)}
          />
          <button
            className="icon-button model-context-save"
            type="button"
            aria-label={language === 'zh' ? '保存上下文' : 'Save context'}
            title={language === 'zh' ? '保存上下文' : 'Save context'}
            disabled={disabled || expanded || !contextDraftChanged || hasInvalidContext}
            onClick={() => onSaveContextTokens(contextDraft)}
          >
            <Check size={14} />
          </button>
        </div>
        {hasInvalidContext && (
          <small>
            {language === 'zh' ? '请输入正整数' : 'Use a positive integer'}
          </small>
        )}
      </label>
      <label className="model-context-editor">
        <span>{language === 'zh' ? '输出' : 'Output'}</span>
        <div className="model-context-controls">
          <input
            aria-label={
              language === 'zh'
                ? `${config.modelName} 最大输出 token`
                : `${config.modelName} max output tokens`
            }
            inputMode="numeric"
            disabled={disabled || expanded}
            min={1}
            placeholder={language === 'zh' ? '供应商默认' : 'provider default'}
            type="number"
            value={completionDraft}
            onChange={(event) => setCompletionDraft(event.currentTarget.value)}
          />
          <button
            className="icon-button model-context-save"
            type="button"
            aria-label={language === 'zh' ? '保存输出上限' : 'Save output limit'}
            title={language === 'zh' ? '保存输出上限' : 'Save output limit'}
            disabled={disabled || expanded || !completionDraftChanged || hasInvalidCompletion}
            onClick={() => onSaveCompletionTokens(completionDraft)}
          >
            <Check size={14} />
          </button>
        </div>
        {hasInvalidCompletion && (
          <small>
            {language === 'zh' ? '请输入正整数' : 'Use a positive integer'}
          </small>
        )}
      </label>
      {selected && (
        <span className="current-badge">
          <CheckCircle2 size={13} />
          {defaultSelection ? language === 'zh' ? '默认' : 'Default' : language === 'zh' ? '当前' : 'Current'}
        </span>
      )}
      {!selected && (
        <button className="secondary-button model-use-button" type="button" disabled={disabled} onClick={onUse}>
          {defaultSelection ? language === 'zh' ? '设为默认' : 'Set default' : language === 'zh' ? '设为当前' : 'Use'}
        </button>
      )}
      <button
        className="icon-button model-delete-button"
        type="button"
        aria-label={language === 'zh' ? `删除 ${config.modelName}` : `Delete ${config.modelName}`}
        title={language === 'zh' ? '删除模型' : 'Delete model'}
        disabled={disabled}
        onClick={onDelete}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

export function normalizeMaxContextTokens(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function normalizeMaxCompletionTokens(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function contextTokenDraftValue(value: number | undefined) {
  return String(value && value > 0 ? Math.floor(value) : defaultMaxContextTokens);
}

function completionTokenDraftValue(value: number | undefined) {
  return String(value && value > 0 ? Math.floor(value) : '');
}
