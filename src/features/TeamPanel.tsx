import { GitBranch, MessageCircle, Sparkles } from 'lucide-react';

import type { AppLanguage } from '../types';

export function TeamPanel({ language }: { language: AppLanguage }) {
  const isChinese = language === 'zh';
  return (
    <div className="feature-content team-lite-content">
      <section className="team-lite-hero">
        <span>{isChinese ? 'Team 模式已并入对话' : 'Team mode now lives in chat'}</span>
        <h2>
          {isChinese
            ? '从一句任务开始，让 Team Agent 逐层形成 Agent Flow。'
            : 'Start from one mission and let Team Agent shape the Agent Flow.'}
        </h2>
        <p>
          {isChinese
            ? '主体验回到聊天输入框：打开 Team 模式，Boss 只做裁决，AI 负责拆层、设计场景 Agent、提出验证闭环。这个页面先作为轻量入口，后续再承接完整 DAG、资产和审计。'
            : 'The primary experience is back in the composer: enable Team mode, let the Boss decide, and let AI design scene agents, layers, and validation loops. This page stays light until full DAG assets and audit views arrive.'}
        </p>
      </section>

      <div className="team-lite-grid">
        <article>
          <MessageCircle size={18} />
          <strong>{isChinese ? '对话是主入口' : 'Chat first'}</strong>
          <p>
            {isChinese
              ? '在输入框左下角打开 Team。用户消息保持原文，Team 约束通过请求上下文发送。'
              : 'Enable Team in the lower-left composer. User messages stay clean; Team constraints travel as request context.'}
          </p>
        </article>
        <article>
          <Sparkles size={18} />
          <strong>{isChinese ? '渐进形成' : 'Progressive flow'}</strong>
          <p>
            {isChinese
              ? '默认只讨论当前层：目标、场景 Agent、工具、验证。需要时再展开全图。'
              : 'Discuss one layer at a time: goal, scene agents, tools, and validation. Expand the full map only when needed.'}
          </p>
        </article>
        <article>
          <GitBranch size={18} />
          <strong>{isChinese ? '精细控制后置' : 'Control later'}</strong>
          <p>
            {isChinese
              ? '完整 DAG、profile 资产和执行审计适合放到后续工作台，不挤占日常对话。'
              : 'Full DAGs, profile assets, and audit trails belong in a later workbench, not the daily chat loop.'}
          </p>
        </article>
      </div>
    </div>
  );
}
