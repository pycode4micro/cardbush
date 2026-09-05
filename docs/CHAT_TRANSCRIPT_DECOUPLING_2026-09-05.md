# 聊天消息模块解耦：第一批

本次只做消息处理与流式缓冲的等价提取，不重写会话状态机。
基线是本次操作开始时的工作区，包含前一批尚未提交的修复；不是 Git HEAD。

## 模块职责

目录：`src/features/chatMessages/transcript/`。

| 模块 | 职责 | 依赖方向 |
| --- | --- | --- |
| assistantStreamBuffer | 分段缓冲、加速展示、排空与定时器清理 | 仅消息类型；不依赖 React |
| messageFacts | 消息身份、顺序、编辑目标与时间事实 | 仅消息类型 |
| toolExecutionMerge | 工具记录合并、原段落详情补全 | messageFacts、已有工具附件/历史适配器 |
| loopHistory | 执行历史保留、折叠和去重 | messageFacts、toolExecutionMerge |
| liveMessageUpdates | 实时事件对应的消息集合更新 | 缓冲类型、messageFacts、loopHistory、toolExecutionMerge |
| messageProjection | 终态/历史合并、活动与完成态显示投影 | messageFacts、loopHistory、toolExecutionMerge、已有计时/Goal 适配器 |

依赖单向；消息模块不导入聊天 Hook、React 状态或 Runtime Client。
`messageProjection` 保留原有本地计时读取和 WeakMap 缓存；不是将这些行为重新实现成另一套缓存。
`assistantStreamBuffer` 保留原有浏览器定时器和可见性/减少动画判断。

`useCardbushChat.ts` 从 7,618 行降至约 4,620 行。
发送、重跑、后台订阅、历史读取保护和停止确认仍由原 Hook 按原顺序协调。
旧导出保留为兼容转导出；App、ShadowWindow 和回放预览组件直接使用消息投影模块。
没有引入全局状态库、事件总线、新的持久化格式或额外模型请求。

## 等价性与验证

- 对开始时的代码快照逐声明比对：迁出 112 个声明、保留 53 个声明的实现一致（只忽略新增的 export 修饰和换行格式）；Hook 主体一致。
- 新增 `npm run test:chat-transcript`：依赖边界、单一实现归属、分段隔离、重复完成、终态迟到文本、动画中 reset/dispose、排空与定时器清理、输入不可变、跨会话引用保留、工具终态/附件保留及显示缓存。
- 引导和停止测试改为构建并加载实际消息模块及其真实依赖，不再运行带空 require 替身的整个 Hook。历史工具、失败提示和编辑目标的部分源码匹配改为行为断言。
- 48/48 契约测试通过；204/204 Runtime 测试通过。
- 会话读取保护、Runtime Host 生命周期、Product Runtime Client、Electron 检查器交互测试通过。
- 前端与 Electron TypeScript 检查通过；Vite 生产构建通过。既有大 chunk 警告仍在，不把文件拆分等同于加载性能提升。

## 只读历史回放

当前数据目录实际保留的会话 `local-4cb41567-c4a5-47da-9cc9-1ef3400bfa3d`：

- 1 个 Turn，12 条显示候选消息，其中 11 个助手段落，16 条工具记录。
- 拆分前后分别执行工具详情补全、终态合并、活动投影、历史合并、历史显示与分段缓冲回放。
- 6 组输出逐序列化哈希相等；会话日志校验及回放前后文件哈希一致，没有写入历史库。

此前提到的 `local-1ce2...`、`local-fe4...` 日志不在当前数据目录中，不计入本次真实历史验证。多轮、引导边界、停止与失败的复杂场景由已有契约样本补充；本次不是对那两个旧会话的完整 GUI 重演。

## 未纳入本批

不改 UI 布局/滚动、模型调用、压缩、cachechain、订阅时序和数据库语义。
未使用付费模型 API，未提交或推送 Git。
后续可拆分 App 的独立视图区，再考虑合并流事件处理；不要在等价提取中顺手重写停止或恢复策略。
