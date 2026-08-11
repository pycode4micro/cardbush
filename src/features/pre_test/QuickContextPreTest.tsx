import { useState, type CSSProperties } from 'react';

import type { AppLanguage, ChatMessage } from '../../types';
import { QuickContextRail } from '../chat/QuickContextRail';

const preTestMessages: ChatMessage[] = [
  user('pt-01', '我们需要修复输入框返回设置页时发生横向位移的问题，重点检查容器宽度和滚动条 gutter。'),
  assistant('pt-02', '我会先比较设置页和聊天页的布局约束，再检查 composer dock 是否重复预留了滚动条宽度。'),
  user('pt-03', '模型管理页面太拥挤，希望减少卡片层级，让模型名称、上下文窗口和当前状态更容易扫描。'),
  assistant('pt-04', '可以将 provider 作为分组标题，模型行只保留名称、最大上下文、当前状态和更多操作。'),
  user('pt-05', '图片上传出现 allowed image root 错误，Windows 路径中包含空格和中文时尤其容易复现。'),
  assistant('pt-06', '需要统一 canonical path，并确保 image_allowed_paths 与实际保存目录使用相同的绝对路径格式。'),
  user('pt-07', 'Team 模式保持普通对话，DAG 全图放到标题栏下方的吸附抽屉，默认收起。'),
  assistant('pt-08', 'Team 状态只使用一个旗帜图标提示，结构化图谱由抽屉承接，不占用主对话。'),
  user('pt-09', '桌面 OS 的应用中心只展示真实安装的软件，图标需要读取 Windows 原生资源。'),
  assistant('pt-10', '应用枚举应过滤卸载器、帮助文档和重复快捷方式，并缓存已经解析的图标。'),
  user('pt-11', '终端输出很长时默认不要换行，但右上角需要支持切换换行和复制完整输出。'),
  assistant('pt-12', '输出正文保持横向滚动，工具栏独立于内容滚动，并使用 Unicode 安全的预览截断。'),
  user('pt-13', 'Shadow 消息只在 loop 中出现，贴在输入框上沿，点击后接管输入区进行独立回复。'),
  assistant('pt-14', 'Shadow 与普通对话隔离，运行结束自动隐藏，默认使用淡绿色作为提示色。'),
  user('pt-14a', '快速上下文需要根据当前输入检索本会话里的相关历史提问，最好沿着左侧时间轴渐进显示。'),
  assistant('pt-14b', '可以先在本地建立轻量索引，悬停相关锚点时再懒加载前后消息，避免一次渲染整段历史。'),
  user('pt-15', 'Thinking 也放在输入框上沿，但是只读，不要写进主消息流，颜色需要在设置中选择。'),
  assistant('pt-16', 'Thinking 使用独立 SSE 事件和淡蓝色标签，与 Shadow 互斥展开。'),
  user('pt-17', '快速上下文应该根据当前输入检索本会话里的相关提问，输入为空就使用上一条用户消息。'),
  assistant('pt-18', '检索会在输入停止后延迟执行，并在左侧时间轨道显示相关锚点。长停后再加载完整上下文。'),
];

export function isQuickContextPreTestEnabled() {
  const query = new URLSearchParams(window.location.search).get('pre_test');
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('pre_test');
  return query === 'quick-context' ||
    hash === 'quick-context' ||
    window.localStorage.getItem('cardbush_pre_test') === 'quick-context';
}

export function QuickContextPreTest({ language }: { language: AppLanguage }) {
  const [draft, setDraft] = useState(() =>
    new URLSearchParams(window.location.search).get('pre_query') === 'empty'
      ? ''
      : '输入框和滚动条为什么会发生横向位移？',
  );
  const style = {
    '--composer-dock-height': '138px',
    '--stream-status-height': '0px',
  } as CSSProperties;

  return (
    <div className="chat-panel quick-context-pre-test">
      <header className="quick-context-pre-test-header">
        <strong>{language === 'zh' ? '快速上下文 · Pre Test' : 'Quick Context · Pre Test'}</strong>
        <small>{language === 'zh' ? '本地占位数据，不连接后端' : 'Local fixtures, no backend required'}</small>
      </header>
      <div className="chat-body" style={style}>
        <QuickContextRail language={language} messages={preTestMessages} draft={draft} />
        <div className="quick-context-pre-test-feed">
          {preTestMessages.map((message) => (
            <article className={message.role} key={message.id}>
              <small>{message.role === 'user' ? (language === 'zh' ? '你' : 'You') : 'CardBush'}</small>
              <p>{message.content}</p>
            </article>
          ))}
          <div className="quick-context-pre-test-spacer" />
        </div>
        <div className="quick-context-pre-test-composer">
          <textarea
            value={draft}
            placeholder={language === 'zh' ? '清空后将使用上一条用户输入检索' : 'Clear to search from the latest user prompt'}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <small>{language === 'zh' ? '停止输入约 1 秒后检索' : 'Search starts after about 1 second of inactivity'}</small>
        </div>
      </div>
    </div>
  );
}

function user(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, createdAt: new Date().toISOString() };
}

function assistant(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, createdAt: new Date().toISOString() };
}
