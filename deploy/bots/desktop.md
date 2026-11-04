# 桌面 Webhook：接入当前上下文

Assistant 和普通本机会话右上角有“连接 Webhook”入口。先开始一个本机会话，再为它添加连接。Assistant 可直接添加。

1. 填写连接名称、Bot 服务接收回复的 URL，保存连接。
2. 把生成的接收地址和令牌填入外部 Bot 服务。令牌只显示为密码，可复制。
3. 若 Bot 服务需要鉴权，在“高级设置 → 回复请求头”填写 JSON，例如 `{"Authorization":"Bearer <你的服务令牌>"}`。
4. “发送测试”只发送 `connection.test`，不会调用模型、读取聊天历史或自动向平台用户发送消息。

模型、插件与权限来自保存时的当前上下文。之后更改这些设置，需要重新保存连接。外部请求不能指定模型、工具权限或切换会话。接收消息后沿用既有 Runtime 会话；Assistant 沿用它的会话日志，后台任务后续结果也会回传。

一个连接固定绑定一个上下文。该连接的不同发送者会共享此上下文，`senderId` / `conversationId` 用于回复路由，不创建隔离会话。外部服务应限制允许接入的用户。需要独立上下文时为不同本机会话分别创建连接。Assistant 清空上下文后旧连接会返回 `context_reset`，重新保存才能使用。

## 默认请求与回复

```http
POST http://127.0.0.1:4791/api/webhooks/v1/{connectionId}/messages
Authorization: Bearer <接收令牌>
Content-Type: application/json
```

```json
{"messageId":"platform-message-001","conversationId":"chat-001","senderId":"user-001","text":"继续刚才的讨论"}
```

`messageId`、`text` 必填。消息 ID 在连接内唯一；重试使用原 ID 和相同内容，不会重复执行。相同 ID 不同内容返回 `409 message_id_conflict`。文本最多 32,000 字符，请求体最多 128 KiB。

成功返回 `202` 和持久回执，`Location` 指向结果地址。请求断开不取消已接受任务。使用相同令牌 `GET 接收地址/{URL编码后的messageId}` 查询结果；回复 URL 留空时可仅使用轮询。

```json
{
  "protocol": "cardbush.webhook.v1",
  "type": "message.completed",
  "eventId": "receipt-id:3",
  "sequence": 3,
  "messageId": "platform-message-001",
  "sessionId": "existing-local-session",
  "conversationId": "chat-001",
  "senderId": "user-001",
  "status": "completed",
  "reply": "完整回复文本",
  "errorCode": ""
}
```

状态包括 `accepted`、`running`、`completed`、`failed`、`stopped`、`interrupted`。回调只投递终态；Assistant 后台任务完成后可以产生更高 `sequence` 的完整回复。接收方按 `eventId` 去重、按 `sequence` 比较新旧，替换完整快照，不把每份快照全部重复追加。

回调头有 `X-CardBush-Event-ID`，返回任意 2xx 表示持久接收成功。失败按退避重试，最大间隔 30 秒，重启后继续；只重发结果，不重复调用模型。回调使用 HTTPS，本机调试可用 loopback HTTP，不跟随重定向。可通过自定义请求头传服务令牌。此桌面接口与 CLI 网关的 HMAC 签名协议不同。

## 高级配置

- **接收字段映射**：JSON 点路径，例如 `{"messageId":"event.id","text":"event.content","senderId":"event.sender","conversationId":"event.room"}`。
- **自定义参数**：存放 Bot 服务要求的固定值，如 `{"room":"room-001"}`。
- **回复模板**：例如 `{"content":"{{reply}}","room":"{{parameters.room}}","revision":"{{sequence}}"}`。精确变量保留原 JSON 类型，字符串由序列化器转义，不执行代码。
- **可用变量**：`reply`、`messageId`、`conversationId`、`senderId`、`sessionId`、`status`、`type`、`eventId`、`sequence`、`errorCode` 和 `parameters.*`。
- **监听地址和端口**：所有桌面连接共用，默认 `127.0.0.1:4791`。远程 Bot 需要可达的 HTTPS 代理或隧道。本机 Bot 无需公网入口。不要把 `0.0.0.0` 当成远端可访问的主机名。

关闭应用后停止接收，重启后恢复。停用连接暂停新消息和回调，已提交的 Runtime 任务继续；移除连接也不会删除原会话。无法确定崩溃前是否已提交的任务标记 `interrupted / submission_unknown`，不自动重做可能有副作用的动作。需要审批的工具操作仍在 Cardbush 内确认，外部文本不能绕过权限。

连接、令牌、策略与回执使用 Electron 系统安全存储加密后保存于用户数据目录的 `webhooks/state.json`。不复制用户消息历史到连接配置。回执目前不自动删除，保留它们可维持消息去重；删除历史回执会失去对应的去重依据。

平台专用认证、扫码、长轮询、格式转换和发消息由仓库外的 Bot 服务实现。Cardbush 内没有平台 SDK，也不启动平台适配器。

## 验证

`npm run test:context-webhooks` 验证真实 Runtime 会话连续性、Assistant 结果关联、重复消息、回调重试、重启恢复以及配置 UI。测试使用临时目录、mock 模型和本机 HTTP 服务，不读取真实账号。
