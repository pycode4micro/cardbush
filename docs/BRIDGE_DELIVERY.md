# 桥接发送与延迟诊断

Assistant 可以直接使用当前工具作用域中由 Runtime 注册的桥接插件。普通 MCP、终端与文件写入能力仍按原有职责交给子 Agent。桥接调用继续经过 `ToolExecutionCoordinator`、文件身份/读取权限检查和消息来源绑定；本地提醒、被禁用的工具及受限执行策略不会因此获得外部发送权限。

## 发送链路

微信桥的出站 Worker 独立于来信转发、Assistant 回复查询和输入状态提示。请求持久化后立即唤醒 Worker；无待发内容时等待事件，有重试时等待登记的重试时间。单个出站 Worker 防止并发扫描重复发送，同一发送的片段保留稳定的平台 client ID，已上传的媒体凭据在重试与重启后复用。文件只有在平台发送成功且完成状态落盘后才清理。

状态包括 `queued`、`uploading`、`sending`、`retrying`、`delivered`、`failed`。查询包含 `phase`、`attempts`、阶段累计耗时、开始/结束时间、最近错误和下一次重试时间。可恢复的传输错误按 1、2、4、8、16、30 秒间隔重试，后续上限为 30 秒；明确的文件缺失、文件身份变化、媒体类型不符及不可信上传地址终止发送。以上判断仅针对协议和传输事实，不判断内容质量，也不指导模型下一步行动。

`accepted` 表示桥接接受调用；`delivered` 表示平台 API 确认，不表示用户已阅读。发送调用的相同请求 ID 仍用于安全重试同一调用，不能跨工具或更换参数复用。只读状态查询重新读取桥接状态，不返回永久缓存的旧快照。

## 完成事件

能力握手声明 `delivery_events` 后，桥接通过已认证的 `POST /api/webhooks/v1/{connectionId}/deliveries` 提交终态。正文为 `protocol`、`eventId`、`sourceRef`、`messageId` 和受约束的 `result`；不包含凭据、CDN 地址或模型指令。

宿主验证连接、原始来信及该连接实际接受的工具调用，持久化不可回退的终态，再写入 Assistant 的 `bridge_delivery_result` 内部事实。它关联原始用户消息，沿用当前 Assistant 配置，不替换模型设置，不恢复用户主动停止的工作。对话 generation 不匹配时不注入旧事件。通知故障可独立重试，不影响后续图片传输；相同终态恢复投递不会重复生成会话事件。晚到的 `queued` HTTP 应答不能覆盖终态。

## 本次修改与验证范围

- 主仓库：桥接工具作用域、只读状态刷新、终态接收、Assistant 内部通知和权限回归。
- 独立微信桥：[cardbush-bridges](https://github.com/pycode4micro/cardbush-bridges) 中的 `src/shared/outbound-worker.mjs`、微信适配器及共享状态投影。本机 npm 命令仍链接到 `cardbush-bridges-main`，对应 Git 检出为同级的 `cardbush-bridges`；桥接改动单独提交到该仓库，不包含在 CardBush 主仓库的提交中。
- 新增测试：`scripts/test-bridge-delivery-events.mjs`、Assistant 管理/会话回归，以及桥接项目的 `test/weixin/outbound-worker.test.mjs`。使用临时配置、模拟平台接口和本地 HTTP，不发送真实用户截图。

本次历史截图缺少阶段时间，无法重建实际 CDN 上传耗时；新诊断记录用于区分排队、上传和平台确认耗时。改动需重新启动 CardBush 和微信桥后生效，未改变用户现有连接和队列数据。
