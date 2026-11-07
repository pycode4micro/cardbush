# 外部 Bot / Agent 接入 `cardbush.webhook.v1`

这是服务端 HTTP 接口。普通对话只需要配对、提交消息和读取结果；需要让宿主显示桥在线或让 Agent 调用平台工具时，再接回调和心跳。微信和飞书已有独立适配器，见[快捷接入](webhook-setup.md)。自建桥负责平台登录、限制允许的发送者、识别原聊天和实际投递。外部 Agent 收到 CardBush 的回复时按回执处理，只将新的用户输入提交为来信，避免两个 Bot 自动互相回复。

## 1. 在同机申请绑定

1. 用服务端 HTTP 客户端请求 `GET http://127.0.0.1:4791/api/webhooks/v1/discovery`。核对 `protocol` 为 `cardbush.webhook.v1`、`capabilities` 含 `local_pairing`。使用响应的 `pairingPath`（当前为 `/api/webhooks/v1/pairings`）。本机发现和配对要求回环连接与回环 Host，不能在浏览器页面发起带 Origin 的请求。
2. 为一次申请生成 UUID `requestId` 和随机的**配对密钥**（Node.js 使用 `randomUUID()` 和 `randomBytes(32).toString('hex')`，来自 `node:crypto`）。有回调时先监听空闲的回环端口并另生成一个**回调密钥**。在桥自己的受保护存储中保留待处理的申请，使轮询和重试复用相同 ID、密钥、名称和参数。
3. 向 `pairingPath` 发 POST，头为 `Content-Type: application/json` 与 `Authorization: Bearer <配对密钥>`。例如下面是一个带回调的请求体，将示例 ID、名称、端口及占位符换成运行时的值：

   ```json
   {
     "requestId": "7fa37b15-a12e-4eb5-8637-7ba2b54d9b89",
     "name": "我的 Bot 服务",
     "replyUrl": "http://127.0.0.1:6186/reply",
     "replyHeaders": { "Authorization": "Bearer <回调密钥>" }
   }
   ```

   仅需从外部 Agent 发消息并轮询答复时，申请只填 `requestId` 和 `name`。这种连接没有实时回调，按消息回执验收对话。
4. 首次响应通常是 HTTP 202、`status: "pending"`。提示用户去**指定的会话**点击「连接服务 → 我的 Bot 服务 → 连接」，或在目标 CLI 的 `/webhook` 中选择它。桥使用同一配对密钥做 `GET {pairingPath}/{requestId}`，例如每 1.5 秒一次，最多等 10 分钟。只有 `connected` 才读取 `connection`；被拒绝或撤销时停止，过期且用户仍要连接时发起新申请。
5. 核对返回的 `connection.sessionId`、`title` 与目标一致，`connection.endpoint` 属于预期的回环宿主和端口，关闭自动跟随重定向。将 **`connection.endpoint` 和 `connection.token`** 保存到桥的私有配置。以后向 CardBush 发消息、看回执、续租都用这个连接令牌；回调服务则校验自己生成的回调密钥。避免将这些值、完整配对响应或请求头输出到日志、命令历史和聊天。下次启动可先带连接令牌 GET 这个 endpoint，`type: "connection.info"` 给出实际绑定的会话。

## 2. 从外部发起一轮对话

要补充正在执行的任务，用新的消息 ID 从同一连接发送普通消息，保留相同的发送者和对话 ID。宿主将其追加到原轮，工具执行期间在安全返回后继续。重复投递同一条消息时使用原 ID；补充回执与原任务最终答复分别关联各自的消息 ID。

向返回的 **endpoint 原样 POST**（路径形如 `/api/webhooks/v1/{connectionId}/messages`），使用 `Authorization: Bearer <连接令牌>`、`Content-Type: application/json`。默认字段示例：

```json
{
  "messageId": "demo-message-42",
  "text": "请原样回复：桥接测试 42",
  "senderId": "demo-user",
  "conversationId": "demo-chat"
}
```

- `messageId` 使用本连接中稳定且唯一的平台消息 ID，`text` 是用户原文。平台桥应同时提供真实 `senderId`、`conversationId`，供回复和工具回到原收件人。目标 CardBush 会话由绑定决定。
- HTTP 202 表示宿主已接收。带同一令牌 GET `{endpoint}/{encodeURIComponent(messageId)}`，或按 POST 返回的同宿主 `Location` 查询。`accepted`、`running` 时稍后再查；`completed` 时读取 `reply`；`failed`、`interrupted`、`stopped` 时记录 `errorCode` 并报告实际状态。出现临时断网或 503 时退避后重试原 ID 和原内容；同 ID 改内容会返回 409 `message_id_conflict`。
- 有 `replyUrl` 时，CardBush 会 POST 终态回执。默认正文含 `type: "message.completed"`、`eventId`、`sequence`、`messageId`、`status`、`reply`、`errorCode` 及来源标识。检查回调密钥并匹配原来信，按 `eventId` 去重、按同一消息的 `sequence` 接收更新，可靠入队后返回 2xx。轮询和回调可能看到同一结果；Assistant 的后台任务也可能产生更高序号的补充回复。

## 3. 声明在线和可选平台插件

有回调的桥启动时向 endpoint 的**同级** `/capabilities` POST JSON（将末尾 `/messages` 替换掉），继续用连接令牌。文本桥的最小示例：

```json
{
  "protocol": "cardbush.webhook.v1",
  "instanceId": "acb2793f-5b9a-4549-ae69-44daabb63ef0",
  "capabilities": { "text": true, "files": false }
}
```

每次桥进程启动生成新的实例 UUID，同一进程每 15 秒用原 UUID 刷新。成功响应为 `status: "connected"`、`leaseSeconds: 45`。正常退出时向同一路径发 DELETE，带同一令牌和 JSON 正文 `{"protocol":"cardbush.webhook.v1","instanceId":"<本进程的 UUID>"}`。

需要文件或其他平台操作时，在声明里提供 `plugins`，检查响应的 `features` 含 `bridge_plugins`。只声明桥确实实现的工具及文件限制。CardBush 将声明注册到绑定会话的工具搜索，工具调用回到同一个 `replyUrl`。按 `type` 区分普通回复、`connection.test` 和 `tool.call`。无文件的工具调用使用 JSON；带文件时是 multipart，`payload` 为 JSON，文件以独立 part 传输。校验来源、版本、参数及文件摘要，以相同 `eventId` 返回 `{"protocol":"cardbush.webhook.v1","eventId":"<原 eventId>","status":"accepted"}`。完整可用声明及回执样例见[桥插件协议](https://github.com/pycode4micro/cardbush/blob/main/docs/WEBHOOK_BOT_PROTOCOL.md)。

## 跨机器或已有 Webhook 服务

能部署同机适配器时，让适配器在 CardBush 机器上走本机配对。已有服务需要跨机器直连时，在目标 App 会话「连接服务 → 手动配置（高级）」设置服务的**回复 Webhook 地址**、认证头，必要时配置入站字段映射和回复 JSON 模板。保存后，把 CardBush 分配的**接收消息地址**和**接收令牌**通过私密渠道配置到服务端。远程两端需要各自可达的地址及受保护的传输，例如 HTTPS 反向代理；远端的 localhost 指向远端自身。测试按钮只检验回调能否接受测试事件，最终以一条真实来信及其回复验收。
