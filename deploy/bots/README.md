# 通用 Bot Webhook

**桌面当前上下文接入：**在 Assistant 或会话右上角点击“连接 Webhook”。基础页只填写名称和回复地址，字段映射、请求头与模板在“高级设置”。操作与协议见 [桌面 Webhook 接入](desktop.md)。桌面连接复用当前会话记录，与下面的独立 CLI 网关分别运行。

本接口连接你已部署的 Bot 服务。由该服务处理飞书、微信或其他平台的消息格式、平台身份和消息发送；Cardbush 只接收统一消息、维护对话并回传回复。没有平台专用 SDK 或适配器。

```text
用户 ⇄ 你的 Bot 服务 ⇄ Webhook / WebSocket ⇄ Cardbush Runtime
```

## 独立 CLI 网关启动

先在本机 Cardbush 配好模型与插件。源码构建使用 `npm run build:agent`，然后在仓库根目录运行下列命令；已安装包含本功能的 CLI 时，将 `node bin/cardbush.mjs` 换成 `cardbush`。

1. 将 [example.json](example.json) 复制到自己的配置目录，修改连接 ID 和 Bot 服务的回复回调 URL。仅需要轮询或 WebSocket 时可删除整个 `callback` 字段。
2. 在启动进程环境中设置 `CARDBUSH_BOT_TOKEN` 和 `CARDBUSH_BOT_CALLBACK_SECRET`，各使用至少 32 字符的随机密钥。前者用于 Bot 服务调用 Cardbush，后者用于 Bot 服务验证回复。配置文件只保存环境变量名；不要把真实密钥放进仓库。
3. 检查并启动：

```powershell
node bin/cardbush.mjs bots --config D:/private/cardbush-bots.json --check
node bin/cardbush.mjs bots --config D:/private/cardbush-bots.json
```

默认复用本机 Cardbush 的模型、插件及网络配置，使用默认模型；可通过配置的 `modelId` 指定已配置模型。API Key 模型可独立运行；通过桌面账号授权桥的模型需要保持桌面应用运行。接口进程需要持续运行；本版本不注册开机服务，也不修改桌面配置。

会话保存在本机 CLI Runtime 中，可以用 `cardbush --resume <sessionId> --local` 打开，不会自动出现在桌面聊天列表。`--profile-dir` 指定共享配置来源，`--data-dir` 指定 CLI 会话目录。回执默认保存在 `~/.cardbush/bot-gateway`，可用 `--state-dir` 改变；重启时继续使用同一个目录。

如果连接现有远程 Cardbush Agent 服务，可追加 `--url https://agent.example/ --token-file /private/agent-access-token`。Bot 令牌和 Agent 令牌是不同凭据，外部 Bot 服务只需要前者。

## 一条消息的协议

`POST /api/bots/v1/{channelId}/messages`

```http
Authorization: Bearer <该连接的令牌>
Content-Type: application/json
```

```json
{
  "messageId": "platform-message-1001",
  "conversationId": "chat-100",
  "senderId": "user-200",
  "text": "帮我总结刚才讨论的方案",
  "threadId": "可选的话题ID"
}
```

- `messageId` 采用平台原始消息 ID，在同一连接内必须唯一。重推使用同一个 ID 和相同内容；修改同一 ID 的内容返回 `409 message_id_conflict`。
- `conversationId`、`senderId`、可选 `threadId` 由已认证的 Bot 服务填写，不从普通消息文本解析身份。每个连接、会话、话题、发送者分别维护上下文，默认不共享群内不同人的上下文。
- 文本上限 32,000 字符，请求体上限 128 KiB。第一版接收文本，附件由 Bot 服务先处理成文字或另行交接，不从外部请求接收本机文件路径、模型配置或工具权限。
- 请求返回 `202` 和持久回执，不等待模型完成。`Location` 头指向消息状态接口。接受后断开 HTTP 请求不会取消任务。

回复和查询都使用同一种快照：

```json
{
  "protocol": "cardbush.webhook.v1",
  "type": "message.updated",
  "channelId": "my-bot",
  "messageId": "platform-message-1001",
  "conversationId": "chat-100",
  "senderId": "user-200",
  "sessionId": "bot-...",
  "requestId": "bot-...",
  "status": "completed",
  "sequence": 17,
  "reply": "模型回复的文本"
}
```

状态为 `accepted`、`running`、`reconnecting`、`needs_input` 或终态 `completed` / `failed` / `stopped` / `interrupted`。`sequence` 用于比较快照的新旧；`reply` 是完整当前文本，应替换而不是重复追加。失败时可带稳定的 `errorCode`；不会回传模型思考、工具参数或工具原始结果。

`GET /api/bots/v1/{channelId}/messages/{URL编码的messageId}` 使用相同 Bearer 令牌查询最新快照。未配置回调时也能完整完成问答。

## 异步回复 Webhook

配置 `callback` 后，Cardbush 在需要人工处理或任务终结时 `POST` 上述快照到固定 URL。回调地址只允许在本地配置，不能由入站消息临时指定。远端回调使用 HTTPS；本机调试允许 loopback HTTP。回调不跟随重定向。

请求头：

```text
X-CardBush-Delivery-ID: <消息回执标识>:<sequence>
X-CardBush-Timestamp: <Unix秒>
X-CardBush-Signature: v1=<HMAC-SHA256十六进制>
```

签名原文是 `timestamp + "." + 原始UTF-8请求体`，密钥为 `secretEnv` 对应值。Bot 服务应检查时间窗口（例如 5 分钟）、恒定时间比较签名，并按 Delivery ID 去重。验证后将 `reply` 发回 `conversationId` 对应的聊天。

Bot 服务持久接收后返回任意 2xx。未成功会退避重试，最大间隔 30 秒，重启也可续投；回调重试不会再次调用模型。语义是至少一次投递，不保证网络上的恰好一次。尚未投递的中间状态可以被更新状态替代，因此每份载荷都是自足快照。回执保留在本地目录，不自动过期；请按自己的留存策略归档，删除回执后不再承诺对应消息的去重。

## 可选 WebSocket 长连接

服务端 Bot 可连接 `ws://127.0.0.1:4790/api/bots/v1/my-bot/events`，握手时附带相同 Bearer 头。远程使用反向代理提供的 `wss://`。不支持把令牌放在 URL；此接口用于服务端对接，不开放跨站浏览器访问。

发送新消息：

```json
{"type":"message","message":{"messageId":"m-1","conversationId":"c-1","senderId":"u-1","text":"你好"}}
```

观察通过 HTTP 提交过的消息，或断线后重新订阅：

```json
{"type":"watch","messageId":"m-1"}
```

立即返回最新完整快照，随后推送该消息的更新。重连只需重新 `watch`，也可以用同 ID 重发原消息；不会重复执行。只推送当前连接主动订阅的消息，不广播其他会话。客户端需响应 WebSocket ping；每 30 秒检测一次失活，慢消费者会断开并可重连。

## 权限与运行边界

模型调用保持 `task_free`，按现有 Cardbush 权限规则执行。需要工具授权或结构化选择时，返回 `needs_input` 和 `attention.kind/id`，在对应本机 CLI 会话处理；本版本不从普通 Bot 文本推断授权，也没有远程批准接口。模型直接用文本提问时，照常发送下一条新消息继续对话。

外部连接可以调用你配置的模型和插件，因此每个 Bot 服务使用不同令牌；需要限制用户时，在连接配置加入 `allowedSenders`。此列表由本机维护。令牌持有者代表该 Bot 服务，必须由服务自身验证平台用户身份。

默认仅监听 `127.0.0.1`。Bot 服务在其他机器时，使用 HTTPS 反向代理或受控隧道访问本机端口；要监听其他地址，显式修改 `host`。同一回执目录只能有一个进程；停止接口会保存状态，不自动停止已经提交给 Runtime 的任务。

## 验证

```shell
npm run test:bot-gateway
```

测试使用临时目录、本机 HTTP 服务和合成模型响应，覆盖去重、上下文隔离、丢失确认、事件续接、重启恢复、回调签名和重投、Webhook/WS 鉴权以及实际 Runtime 两轮对话。不会发送真实飞书或微信消息，也不调用付费模型。
