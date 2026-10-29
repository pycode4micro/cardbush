# CardBush Runtime Client 边界

[English](README.md) · [简体中文](README.zh-CN.md)

本目录属于产品层，只将结构化 Runtime 协议值适配到 React，不实现 Agent Runtime 语义。`@cardbush/bush-protocol` 是协议事实来源；ProtocolRuntimeClient 把事件/能力解码器注入传输无关的 RuntimeClient，不复制 schema。

允许：通过注入传输打开类型化事件流、发送命令、为产品/视觉测试提供 fixture 传输、向宿主转发取消。

禁止：从回复文本/工具名推断状态；判断 Turn/Goal/Subagent 完成；重试模型/工具；重排、合并或伪造 Runtime 事件；访问 Runtime SQLite；实现授权规则或解释工具原生结果语义。

FixtureRuntimeTransport 接受原始 fixture；createRuntimeFixtureClient 在任何功能接收前通过 Runtime 解码器校验完整数据，使测试和真实宿主在同一契约边界失败。RuntimeTurnProjection 再分别投影思考与回复片段，仅 turn_terminal 决定终态。

ElectronRuntimeSession 将相同投影接到 window.cardbushDesktop.runtime，在发送 Turn 前订阅事件。用户取消后仍保留流等待 Runtime 的 stopped 终态，不把 IPC 异常改写成模型/网络文案。React 订阅 RuntimeTurnStore，不直接调用 preload IPC。

命令与订阅共同结算。命令拒绝时最多留 250 ms 排空在途终态，然后关闭订阅；没有终态则暴露原错误。流失败也释放本地等待，不要求未结束命令先完成；两条路径都不伪造终态或自动重试工具。

工具/审批按稳定调用/权限 ID 投影。工具终态事件仅描述调用生命周期；精确原始回执、Runtime 错误和工作区变更从执行记录读取，不能解析显示正文来创造生命周期事实。审批答案先校验 bush.runtime_permission_answer.v1；只有 permission_requested 发布可授予的精确 capability ID 后，UI 才开放允许操作。

Provider 凭据仅通过 runtime.upsert_provider_binding 跨类型化 IPC。Utility Process 返回不透明 bindingId + revision，只有引用进入请求/检查点/日志。修改配置创建不可变修订，活动 Turn 不会在轮间静默切配置。修订是精确配置的确定性单向指纹，重启后同配置恢复同引用，而不是把凭据写入 Runtime 状态。

历史仅通过类型化命令获取。getSession、assembleSessionContext、runSessionTurn 解码 bush.session_*，renderer 不读日志或装配上下文。Runtime 拥有追加顺序、显式替换、崩溃恢复和原子提交；仅暴露方法不等于切换现有产品路径。

GoalContinuationRunner 组合普通持久 Session Turn，只观察 Runtime 的 Goal 状态，在 active 时追加调用方提供的用户续做消息；不从文本、计划节点、工具名、耗时或 loop 次数猜完成。
