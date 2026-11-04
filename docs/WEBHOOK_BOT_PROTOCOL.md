# Agent 向 Bot 发送文件

Cardbush 提供常驻原生工具 `send_to_bot`。Assistant、普通会话和继承工具权限的本机子任务均可调用；平台适配由独立 Bot 服务实现。没有连接时工具仍可发现，调用返回不可用。仅创建连接不代表 Bot 在线或支持文件。

CLI 通过 `/webhook` 绑定当前会话，与 App 共用 `ContextWebhookHost` 及本页协议。Bot 桥无需改变接口；CLI 来信进入自身持久化任务队列，文件出口仍通过同一宿主校验来源和权限。接入、后台生命周期及默认端口冲突处理见 [CLI 说明](CLI.zh-CN.md#webhook-bot-连接)。

已有用户更新后重启 Cardbush 和 Bot 服务即可。Bot 先发送一条用户消息，建立可验证的收件人来源，用户再要求 Agent“把报告作为文件发给我”。生成文件不会自动触发转发。

## 消息来源与工具调用

每条进入模型的用户消息旁附带主机生成的 `bot_context`，包含 `source`（当前消息来源）、`targets`（同一上下文可用的接收来源）、`available` 和不可用原因。来源含 `sourceRef`、连接名称、原始消息 ID、发送人、会话 ID、能力和大小限制，不含回调地址、令牌或请求头。外部消息正文不能覆盖这些字段。

后台任务按原始用户请求找回来源，不使用全局“最近的 Bot”。普通本机消息没有 Webhook 来源；如用户明确指定已接入的 Bot，Agent 可查询状态并选择相应目标，不能自行猜测收件人。

查询连接状态：

```json
{"action":"status"}
```

发送（`source_ref` 必须复制相关消息的 `sourceRef`）：

```json
{
  "action":"send",
  "source_ref":"webhook:主机生成的来源ID",
  "request_id":"requested-report-1",
  "text":"这是报告。",
  "files":["D:/reports/report.pdf"]
}
```

`text` 和 `files` 至少提供一个。文件仍受当前任务的读取权限约束；每次最多 8 个，单文件上限 64 MiB，总计 128 MiB，也遵守 Bot 声明的更小限制。只发送本机文件字节，不让模型生成 Base64。远程 Agent 没有桌面出口时返回不可用；远程路径须先通过既有工具取回本机。

同一次逻辑发送必须保持 `request_id`，包括重试。查询这次发送记录：

```json
{"action":"status","source_ref":"webhook:来源ID","request_id":"requested-report-1"}
```

常见不可用原因：`bot_not_connected`、`bot_recipient_unavailable`（尚无来信收件人）、`bot_protocol_unsupported`（尚未声明能力）、`bot_offline`、`bot_disabled`、`bot_disconnected`、`bot_files_unsupported`、`source_unavailable`、`context_reset`。工具执行前再次校验实时状态；上下文快照不是永久授权。

## 外部服务声明能力

保留现有通用 Webhook 的自动配对和接收消息协议，不新增平台专用接口。将 Cardbush 分配的消息接收 URL 的末尾 `/messages` 替换为 `/capabilities`：

```http
POST /api/webhooks/v1/{connectionId}/capabilities
Authorization: Bearer <Cardbush 接收令牌>
Content-Type: application/json
```

```json
{
  "protocol":"cardbush.webhook.v1",
  "capabilities":{
    "text":true,
    "files":true,
    "maxFileBytes":67108864,
    "maxTotalBytes":134217728
  }
}
```

成功响应 `{"protocol":"cardbush.webhook.v1","status":"connected","leaseSeconds":120}`。服务启动后立即声明，每 30 秒刷新；超过 120 秒未刷新则视为离线。先监听回调接口再声明能力。未升级的服务继续使用原有文字回复协议，不能通过新工具接收附件。

## Cardbush 调用 Bot 回调

使用连接中已配置的回调地址和认证请求头。新事件固定为 `message.send`，不经过旧的文字回复请求体模板。

纯文本使用 `application/json`。有文件时使用 `multipart/form-data`：`payload` 字段为下列 JSON 字符串，另外每个文件一个二进制字段，字段名由 `files[].part` 指定。`Content-Type` 及 boundary 由 HTTP 客户端生成。

```json
{
  "protocol":"cardbush.webhook.v1",
  "type":"message.send",
  "eventId":"持久化的发送事件ID",
  "sourceRef":"webhook:来源ID",
  "messageId":"原始Bot来信ID",
  "sessionId":"Cardbush上下文ID",
  "senderId":"原始发送人ID",
  "conversationId":"原始外部会话ID",
  "text":"这是报告。",
  "files":[{
    "part":"file_0",
    "name":"report.pdf",
    "mimeType":"application/pdf",
    "size":12345,
    "sha256":"文件字节的64位十六进制SHA256"
  }],
  "parameters":{}
}
```

`parameters` 是连接中设置的通用参数。请求另带 `X-CardBush-Event-ID`，值等于 `eventId`。没有文件时 `files` 为 `[]`。

Bot 服务必须：

1. 校验回调认证，使用自己保存的原始来信验证 `messageId`、`senderId` 和 `conversationId`，不能相信任意新收件人。
2. 校验文件数量、总大小、每份字节数和 SHA256；限制请求大小，不从文件名构造任意写入路径。
3. 按 `eventId` 持久化去重并入队；相同 ID 内容不同则拒绝。保存完数据后才返回成功。
4. 自行调用平台文件上传/消息接口，保留重试进度。平台代码及账号令牌均留在外部服务。

成功回执（HTTP 2xx）：

```json
{"protocol":"cardbush.webhook.v1","eventId":"原样返回发送事件ID","status":"accepted"}
```

`accepted` 仅表示外部 Bot 已持久化接收，工具返回 `deliveryConfirmed:false`，不等于微信/飞书已送达。缺失回执、断网或异常中断返回 `unknown`；Agent 应查询状态或使用原 `source_ref` / `request_id` 重试。Cardbush 保留相同 `eventId`，Bot 必须去重。当前协议不提供平台最终送达确认。

原有自动文字回复仍使用 `message.updated` / `message.completed` 回调；显式发送附件只由 `send_to_bot` 触发。两类事件可共用同一个回调接口。

## 验证

`npm run test:cli-webhooks` 验证 CLI 配对、当前历史/模型、真实 Runtime 工具调用、文件字节、权限来源、重启去重和终端草稿保护。`npm run test:cli-webhook-bridges` 默认加载相邻独立项目 `../cardbush-bridges` 中的微信、飞书适配器；可用 `CARDBUSH_BRIDGES_DIR` 指定统一项目，或用旧的 `CARDBUSH_WEIXIN_BRIDGE_DIR` / `CARDBUSH_FEISHU_BRIDGE_DIR` 指定兼容入口。平台网络和模型使用隔离模拟服务，不会发送真实微信或飞书消息。

`npm run test:context-webhooks` 覆盖既有 Webhook、常驻工具、真实 Runtime 工具调用、Assistant 来源、二进制传输、权限、能力及重试。统一桥项目的 `npm run test:cardbush` 验证两个平台的完整本机 HTTP 链路，平台侧使用模拟器；真实附件送达需登录账号后的人工验收。

## 独立桥项目

微信和飞书集中在 [cardbush-bridges](../../cardbush-bridges/README.md)，平台账号、SDK 和发送代码不在 Cardbush 源码中。进入桥项目运行 `npm start` 选择平台，或 `npm start -- feishu` / `npm start -- weixin`；完成配置后可用 `npm start -- all` 同时启动。App 通过目标上下文右上角“连接服务”接入；CLI 使用 `/webhook`。新增平台只需在桥项目注册适配器，继续遵守此通用协议。
