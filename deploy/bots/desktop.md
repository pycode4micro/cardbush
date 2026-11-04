# 桌面 Webhook：接入当前上下文

Assistant 和普通本机会话右上角有“连接服务”入口。先开始一个本机会话，再为它添加连接。Assistant 可直接添加。

1. 打开 Cardbush，启动支持本协议的本机 Bot 服务。
2. 在要复用的会话右上角打开“连接服务”，找到该服务，点击“连接”。
3. 服务自动保存接收地址和凭据；按服务自身提示完成平台登录，即可收发消息。以后重启直接复用连接。

基础流程不填写地址、端口、令牌或 JSON。桌面服务固定默认地址为 `http://127.0.0.1:4791`，无需另外启动命令行网关；独立 Agent 服务默认端口为 `4780`，CLI Bot 网关为 `4790`，它们与桌面接入分别运行。凭据随机生成，只有地址与协议路径是固定值。

模型、插件与权限来自保存时的当前上下文。之后更改这些设置，需要重新保存连接。外部请求不能指定模型、工具权限或切换会话。接收消息后沿用既有 Runtime 会话；Assistant 沿用它的会话日志，后台任务后续结果也会回传。

一个连接固定绑定一个上下文。该连接的不同发送者会共享此上下文，`senderId` / `conversationId` 用于回复路由，不创建隔离会话。外部服务应限制允许接入的用户。需要独立上下文时为不同本机会话分别创建连接。Assistant 清空上下文后旧连接会返回 `context_reset`，重新保存才能使用。

## 本机服务自动接入协议

任意本机服务均可实现以下流程；Cardbush 不识别具体平台，也不负责平台登录。

1. 请求 `GET http://127.0.0.1:4791/api/webhooks/v1/discovery`，响应为：

   ```json
   {"protocol":"cardbush.webhook.v1","capabilities":["local_pairing"],"pairingPath":"/api/webhooks/v1/pairings"}
   ```

2. 服务生成 UUID `requestId` 和 32 字节随机密钥（64 个小写十六进制字符），先在服务自身的私有配置中保存。使用该密钥申请连接：

   ```http
   POST http://127.0.0.1:4791/api/webhooks/v1/pairings
   Authorization: Bearer <申请密钥>
   Content-Type: application/json
   ```

   ```json
   {
     "requestId":"a8e4b56c-3493-41a7-97f3-12e7557c3cc4",
     "name":"My local Bot",
     "replyUrl":"http://127.0.0.1:4792/reply",
     "replyHeaders":{"Authorization":"Bearer <服务自行生成的回调密钥>"}
   }
   ```

   `replyUrl` 和 `replyHeaders` 可省略，省略后仅轮询结果。自动接入仅接受本机 HTTP 回调；`4792` 只是示例，服务可以自行选端口。请求体最多 16 KiB，名称最多 80 字符。此请求不能指定 Cardbush 会话、模型或权限。相同申请 ID、密钥和参数可以重试，不会创建多个连接。

3. 收到 `202`、`status: "pending"` 后，使用相同申请密钥每隔约 1.5 秒查询 `GET /api/webhooks/v1/pairings/{requestId}`。提示用户在所需会话的“连接服务”中点击“连接”。等待期间不会返回会话历史或接收凭据，也不会调用模型。

4. 用户连接后，查询返回：

   ```json
   {
     "protocol":"cardbush.webhook.v1",
     "requestId":"a8e4b56c-3493-41a7-97f3-12e7557c3cc4",
     "status":"connected",
     "connection":{
       "id":"<connectionId>",
       "endpoint":"http://127.0.0.1:4791/api/webhooks/v1/<connectionId>/messages",
       "token":"<随机接收令牌>",
       "sessionId":"<用户选择的会话>",
       "title":"<会话标题>"
     }
   }
   ```

   服务私密保存 `endpoint` 和 `token`，删除临时申请密钥，开始使用下面的消息协议。重启不需要重新申请；向 `endpoint` 发送带接收令牌的 `GET` 可检查连接，返回 `type: "connection.info"`、`sessionId` 和 `title`。

申请有效期为 10 分钟，Cardbush 重启后仍保留未过期申请。用户忽略申请时返回 `rejected`；已获准连接被停用或删除后，尚未过期的申请查询返回 `revoked`，原消息地址返回 `401 unauthorized`。过期查询返回 `410 pairing_expired`。拒绝、撤销后由用户主动重新连接，不要自动反复申请；应用暂时离线时保留已有凭据，等待重连。更换上下文需要新申请和新的点击授权，旧连接不能被远端改绑。

发现和配对只允许来自 loopback 的非浏览器请求；即使高级设置开放了外网监听，也不开放远程配对。请求须使用 loopback Host，不带 `Origin`。申请密钥、接收令牌、回调密钥各自独立；不得放入 URL 或日志。远程服务和现有非标准 Bot 使用下方手动配置。

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

“连接服务 → 手动配置（高级）”保留原有接入方式：填写名称和回复 URL，保存后将生成的接收地址、接收令牌交给外部服务。服务要求鉴权时，在“高级设置 → 回复请求头”填写 `{"Authorization":"Bearer <服务令牌>"}`。这些字段也可通过已连接服务旁的“设置”修改。已有手动连接不受自动接入功能影响。

“发送测试”只发送 `connection.test`，不会调用模型、读取聊天历史或自动向平台用户发送消息。

- **接收字段映射**：JSON 点路径，例如 `{"messageId":"event.id","text":"event.content","senderId":"event.sender","conversationId":"event.room"}`。
- **自定义参数**：存放 Bot 服务要求的固定值，如 `{"room":"room-001"}`。
- **回复模板**：例如 `{"content":"{{reply}}","room":"{{parameters.room}}","revision":"{{sequence}}"}`。精确变量保留原 JSON 类型，字符串由序列化器转义，不执行代码。
- **可用变量**：`reply`、`messageId`、`conversationId`、`senderId`、`sessionId`、`status`、`type`、`eventId`、`sequence`、`errorCode` 和 `parameters.*`。
- **监听地址和端口**：所有桌面连接共用，默认 `127.0.0.1:4791`。远程 Bot 需要可达的 HTTPS 代理或隧道。本机 Bot 无需公网入口。不要把 `0.0.0.0` 当成远端可访问的主机名。

关闭应用后停止接收，重启后恢复。停用连接暂停新消息和回调，已提交的 Runtime 任务继续；移除连接也不会删除原会话。无法确定崩溃前是否已提交的任务标记 `interrupted / submission_unknown`，不自动重做可能有副作用的动作。需要审批的工具操作仍在 Cardbush 内确认，外部文本不能绕过权限。

连接、令牌、策略与回执使用 Electron 系统安全存储加密后保存于用户数据目录的 `webhooks/state.json`。不复制用户消息历史到连接配置。回执目前不自动删除，保留它们可维持消息去重；删除历史回执会失去对应的去重依据。

平台专用认证、扫码、长轮询、格式转换和发消息由仓库外的 Bot 服务实现。Cardbush 内没有平台 SDK，也不启动平台适配器。

## 验证

`npm run test:context-webhooks` 验证本机发现、点击授权后交换参数、拒绝与撤销、重启恢复、真实 Runtime 会话连续性、Assistant 结果关联、重复消息、回调重试以及双语和双主题配置 UI。测试使用临时目录、mock 模型和本机 HTTP 服务，不读取真实账号。
