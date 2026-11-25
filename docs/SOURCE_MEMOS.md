# Source 依据备注

[English](SOURCE_MEMOS.en.md) · [简体中文](SOURCE_MEMOS.md)

Source 在输入框的 `＋` 中切换，按会话保存，默认开启。发送、排队和重试保留提交时的开关状态；新会话回到开启。它只控制最终回复的说明标注，普通文件、媒体、网页、提取和消息引用不受影响。

## Markdown 依据

模型在同一条回复中写 `[^cause]` 和 `[^cause]: 说明与 [原始资料](...)`。对话将脚注显示为原位置的依据卡片，支持点击、悬浮和键盘操作。文件、网页链接和 Markdown 摘录可以直接放在脚注中。新脚注随消息保存。

## 历史依据

历史 Memo 链接、原文片段和版本信息继续从原始执行记录读取。旧编号只有在会话与回合的记录确认后才绑定。文件移动、修改或删除后，仍可查看之前保存的原文片段。缓存清理保留被历史消息引用的记录。

## 验证

- `packages/bush-runtime/test/sourceMemo.test.mjs`：会话独立编号、文件序号隔离、重试与重启、旧 memo 兼容、分叉继承、版本变化、缺失文件和输入边界；`cacheMaintenance.test.mjs` 验证新旧完整引用在跨会话复制后的保留。
- `packages/bush-product-agent/test/conversationPreferencesLifecycle.test.mjs`：Source 开关、实际 provider 前缀、压缩与重启。
- `scripts/test-source-memo-ui.mjs`：实际 Markdown 渲染、两个会话同号标注与完整链接复制、预载悬浮、键盘/点击、旧引用、主题与窄窗口。
- `scripts/test-subagent-conversation-ui.mjs`：主会话复用组件中的子会话开关、引导及队列状态快照。
