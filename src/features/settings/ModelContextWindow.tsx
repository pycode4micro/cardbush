import { useId, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { resolveContextBudget, type ContextBudget } from '@cardbush/bush-protocol';
import type { AppLanguage } from '../../types';

export function ModelContextWindow({ contextTokens, outputTokens, language }: {
  contextTokens: number; outputTokens?: number; language: AppLanguage;
}) {
  const zh = language === 'zh', helpId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  let budget: ContextBudget | undefined;
  try { budget = resolveContextBudget(contextTokens, outputTokens); } catch { /* The form validates incomplete edits on save. */ }
  const count = (value: number) => value.toLocaleString(zh ? 'zh-CN' : 'en-US');
  const regularBudget = budget ? budget.normalInputLimit - budget.compactionOutputTokens - budget.safetyTokens : undefined;
  return <div className="model-context-window">
    <div className="model-context-window-heading">
      <span>{zh ? '对话上下文窗口' : 'Conversation context window'}
        <button type="button" className="model-context-help-button" aria-label={zh ? '上下文窗口计算说明' : 'How context windows are calculated'}
          aria-expanded={helpOpen} aria-controls={helpId} onClick={() => setHelpOpen(value => !value)}><CircleHelp size={14}/></button>
      </span>
      <output aria-label={zh ? '对话上下文窗口' : 'Conversation context window'}>{budget ? `${count(budget.compactionTriggerTokens)} tokens` : '—'}</output>
    </div>
    <p>{budget ? zh ? '自动计算，达到此预算后触发上下文压缩。' : 'Calculated automatically; context compacts at this budget.'
      : zh ? '请输入有效的总体窗口，并确保最大输出小于总体窗口。' : 'Enter a valid total window with an output limit below it.'}</p>
    {helpOpen && <div id={helpId} className="model-context-window-help">
      <p>{zh ? '总体上下文窗口是模型单次请求可容纳的输入与输出总量，填写模型支持的上限。对话上下文窗口是压缩触发预算，包含历史对话、系统提示、工具定义及工具结果等输入，并非单纯的聊天文字。'
        : 'The total context window is the model’s capacity for input and output in one request. Enter the model’s supported limit. The conversation window is the compaction budget for all input, including history, system instructions, tool definitions and tool results.'}</p>
      <p>{zh ? '为下一次回复及思考预留最大输出额度，再为后续压缩的摘要及思考预留同等额度；另留安全余量，用于压缩指令、后续工具结果和 token 估算误差，避免窗口耗尽时无法完成压缩。'
        : 'Reserve the maximum output for the next reply and its reasoning, then the same allowance for a compaction summary and its reasoning. A safety margin covers compaction instructions, subsequent tool results and token estimation error, so compaction can finish before the window is exhausted.'}</p>
      {budget && <>
        <dl>
          <div><dt>{zh ? '总体上下文窗口' : 'Total context window'}</dt><dd>{count(budget.contextWindowTokens)}</dd></div>
          <div><dt>{zh ? '回复与思考预留' : 'Reply and reasoning reserve'}</dt><dd>−{count(budget.normalOutputTokens)}</dd></div>
          <div><dt>{zh ? '压缩输出预留' : 'Compaction output reserve'}</dt><dd>−{count(budget.compactionOutputTokens)}</dd></div>
          <div><dt>{zh ? '安全余量' : 'Safety margin'}</dt><dd>−{count(budget.safetyTokens)}</dd></div>
          <div><dt>{zh ? '对话上下文窗口' : 'Conversation context window'}</dt><dd>{count(budget.compactionTriggerTokens)}</dd></div>
        </dl>
        {regularBudget !== budget.compactionTriggerTokens && <p>{zh
          ? `常规预留后为 ${count(regularBudget!)} tokens；按下方安全边界调整为 ${count(budget.compactionTriggerTokens)} tokens。`
          : `The reserves leave ${count(regularBudget!)} tokens; the safety bounds below adjust this to ${count(budget.compactionTriggerTokens)} tokens.`}</p>}
      </>}
      <p>{zh ? '还会将触发预算限制在单次可用输入容量的 95% 以内；最大输出占比过大时，保留至少 50% 的可用输入容量，避免反复压缩。实际输入会随一轮回复或工具结果增长，因此触发时可能略超过对话预算。服务商限制或请求体大小也可能让压缩提前发生。'
        : 'The trigger stays within 95% of available input capacity. When output reservations are large, at least 50% of input capacity remains to avoid repeated compaction. A reply or tool result can take usage past the conversation budget before the next check. Provider or request-size limits can also trigger compaction earlier.'}</p>
    </div>}
  </div>;
}
