# 语音与 assistant

普通会话与 assistant 共用通话控制；标准和精简输入框均支持长按进入通话、单击录音。返回文字输入不会挂断；切换会话或最小化应用也不重建通话。实时通话与「转写 + Agent + 朗读」是不同路径，Qwen3-TTS 等朗读模型的设置不会改变实时语音模型。

已接通后的短暂网络断线会有限自动重连。界面显示恢复状态，先恢复历史摘要、近期问答和子任务回执，再继续收音；不会重放旧工具调用。缓存满五秒后暂停收音而不挂断，恢复后可能需要重说断线期间未识别的那一句。重新接通也读取同一会话的加密历史；过长记录先整理，不静默裁掉旧问答。明确的授权/协议错误、用户挂断不循环重连。

assistant 是固定身份的持续会话，可改名称、头像和角色。普通会话没有助手角色扮演。assistant 的口头交流在后台记录，页面只显示文本消息、page_write 和可点击的子任务气泡，不显示语音逐字稿或 Agent loop。点击任务气泡复用现有子会话执行查看器；远程任务仍打开它原本的执行主机。重置清理上下文，不因切换页面取消任务。

语音模型仅使用 subagent、await_subagent、send_subagent_message、read_subagent_conversation；assistant 额外有 page_write。派发立即返回，await_subagent 只登记观察，均不阻塞通话。执行权限沿用当前 Agent；不可因语音层口头声明改变工具禁用状态。

完成结果先由当前配置的执行模型生成独立的口述摘要，再在对话空隙播报。摘要不是新的执行轮，不带执行工具。长路径、表格与完整列表留在任务详情。摘要失败时仅提示有结果可查看，不朗读原文截断片段；因此一次完成通知可能额外消耗文字模型用量。正在讲话和播放时延后通知，挂断取消摘要等待但不取消后台任务。

语音设置可选择火山原生接入，或 CardBush Realtime 兼容服务，分别保存模型 ID、音色与加密密钥。模型 ID 是否可用以服务实际握手/推理为准；本地不会猜测或承诺所有型号可用。兼容服务必须实现 [协议](realtime-protocol.md)，不能把任意厂商 WebSocket 地址填入后就视为适配完成。更换地址不沿用旧密钥；进行中的通话使用启动时的配置，保存切换在下次接通生效。

源码入口：`electron/realtimeVoiceService.ts`（连接与空隙通知）、`src/features/voice/realtimeVoiceCall.ts`（应用级通话）、`src/backend/realtimeAgent.ts`（执行桥）、`packages/bush-runtime/src/realtimeTaskSummary.ts`（口述总结）、`src/features/assistant/AssistantTaskBubble.tsx`（执行入口）。不把这些内部方法当作模型已经获得的工具。
