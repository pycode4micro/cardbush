# Webhook 桥插件协议

平台能力由独立桥项目提供。Cardbush App 和 CLI 只管理连接、消息来源、插件发现、权限和通用调用。微信、飞书的 SDK、账号、上传逻辑和发送队列均在桥项目内。常驻 `send_to_bot` 已移除。

## 使用与生命周期

主动事件和对话共用 Assistant 的「连接服务」。可以绑定多个微信号；从外部发起的事件沿原连接和收件人回复，本地事件可在 Assistant 设置中选择默认通知对话。已有 Friends 桥在升级后沿用原令牌、消息回执和来源，无需再次配对。

更新后重启 Cardbush 和独立桥。在 App 的 Assistant / 会话右上角“连接服务”选择桥；CLI 输入 `/webhook`。已保存连接自动恢复，无需再复制地址或令牌。桥声明的插件进入当前会话的工具搜索，Agent 使用 `mcp_search` → `get_tool_schema` → `call_tool`；Assistant 可以搜索并委派子任务执行。

同一桥、同一发送者、同一外部对话在原任务执行期间再次发送普通消息，会立即追加到该轮。模型正在推理时取消该次模型请求并读取补充；正在执行的工具先安全返回，再带结果和补充继续。补充消息有独立的接收回执，任务结果由原消息返回。原轮已结束时新消息开启下一轮。不同账号、群聊、发送者及缺少来源标识的消息独立处理。

Webhook 来信统一使用“完全访问”（`all_free`），结构化问题工具 `request_user_input_async` 不可用。需要用户补充信息或选择时，Agent 在最终回复中提出问题并结束本轮，用户下一条消息继续原会话。该规则同时适用于 App、Assistant、CLI 和旧连接的新来信；不更改普通本地输入的权限设置，也不改变远程部署自身的权限上限。

保存的连接保留模型配置 ID；每次新消息执行前，桌面宿主重新向当前 Runtime 注册该模型及固定的子任务模型，避免重启后引用已失效的进程内配置。更新模型配置后使用同一 ID 的当前配置；模型被移除时明确失败，不切换到默认模型。恢复已有回执只读取结果，不重新执行任务；Assistant 的“重试回复”保留原消息及来源，并重新准备模型配置。

清空 Assistant 上下文或重启 Runtime 后，已保存的连接仍然有效。每条首次接收的新消息绑定当前上下文，无需重新连接桥；新消息的自动绑定不会修改已有回执。排队、恢复和工具调用仍检查原上下文标记，重复消息 ID 返回原回执，不触发重新绑定或执行。

在 Bot 说“把报告作为文件发给我”即可。当前两桥各提供 `send_text`、`send_file`、`delivery_status`。工具默认使用当前消息来源；生成文件本身不会触发发送。

正常关闭时立即撤销声明；进程崩溃或断网最多 45 秒后租约过期。下一次目录刷新移除工具，已加载的旧工具在执行时仍会检查实时连接。工具仅在绑定会话及获准的子任务内可用，不会全局安装，也不会下载或执行桥提供的代码。普通文字回复保持原有流程。

## 声明插件集合

保留 `cardbush.webhook.v1` 的自动发现、配对和消息接口。桥先监听回调，将 Cardbush 分配的 `/messages` 地址替换为 `/capabilities`，启动时及每 15 秒刷新一次：

```http
POST /api/webhooks/v1/{connectionId}/capabilities
Authorization: Bearer <Cardbush 接收令牌>
Content-Type: application/json
```

```json
{
  "protocol": "cardbush.webhook.v1",
  "instanceId": "本次桥进程UUID",
  "capabilities": {"text": true, "files": true, "maxFileBytes": 67108864, "maxTotalBytes": 134217728},
  "plugins": [{
    "id": "example", "name": "Example Bot", "version": "1.0.0",
    "description": "Example 平台能力",
    "tools": [{
      "name": "send_file", "description": "发送用户要求的文件到当前来信会话",
      "inputSchema": {
        "type": "object", "properties": {"file": {"type": "string", "description": "本机文件路径"}},
        "required": ["file"], "additionalProperties": false
      },
      "fileArguments": ["file"], "readOnly": false
    }]
  }]
}
```

成功响应含 `status: "connected"`、`features: ["bridge_plugins"]`、`leaseSeconds: 45`。桥应检查 feature，旧宿主不支持时提示升级。Cardbush 重启后必须收到新心跳，不沿用保存的旧在线状态。

App、CLI 与模型使用同一份实时状态：`connected` 表示连接已启用且心跳租约有效；`offline` 表示配置仍然保存但没有在线桥；`disabled` 表示用户已停用。保存配置或启动本地接收接口不代表桥已连接。正常停止通过 DELETE 撤销租约，异常退出最多等待 45 秒过期；App 打开的连接列表每 1.5 秒刷新。

每连接最多 16 个插件，每插件最多 64 个工具。插件 ID、工具名及文件参数名以小写字母开头，使用字母、数字、下划线，最长 40 字符。工具参数为 JSON Schema 对象，运行时验证原始值，不隐式转换类型。`source_ref`、`request_id` 是宿主保留字段，不得声明为插件属性。`fileArguments` 指定顶层本机路径参数（字符串或字符串数组）；未声明就不会读取文件。`readOnly` 默认 false，插件作者必须如实声明副作用。

模型工具名为 `mcp__bridge_<connectionId去连字符>_<pluginId>__<toolName>`，不同连接互不覆盖。声明更新刷新工具版本，旧声明调用被拒绝。Agent 可按平台名、插件描述和工具能力搜索。增加平台特有工具只需修改桥。

停止时向同一路径发送 DELETE，正文为 `{"protocol":"cardbush.webhook.v1","instanceId":"本进程UUID"}`。仅撤销匹配实例，旧进程不能撤销新进程租约。

## 来源与权限

每条来信旁附带宿主生成的 `bot_context`，含 `sourceRef`、连接、原始消息、发送人、外部会话、状态、文件限制和插件工具名，不含地址、令牌或请求头。外部正文不能覆盖来源。

`messageSource.kind` 明确区分 `local` 与 `webhook`；历史收件人 `targets` 不表示本次消息来自 Bot。`connections` 只提供当前会话保存的服务名称、ID 和实时状态。Assistant 每轮模型请求（含重试）刷新状态，历史在线快照不能作为当前连通性的证据；没有心跳按离线处理，不推断为平台协议不兼容。

工具继承当前请求来源；同时处理多个来源时，通过 `source_ref` 在获准来源中明确选择。跨平台或跨用户误用被拒绝。后台任务继承原请求来源，不使用“最近的 Bot”。本机请求无来源时，同一桥只有一个已知收件人才能默认选择，否则必须指定有效来源。

文件读取使用现有权限审批和路径身份校验。宿主最多 8 个文件、单文件 64 MiB、合计 128 MiB，且遵守桥声明的更小限制。当前两桥的 `send_file` 每次发一个文件。远程任务须先通过现有工具把文件取回本机。

## 工具调用回调

使用连接中配置的回调地址及认证请求头发送 `tool.call`，不套用普通文字回复模板。无文件用 JSON，有文件用 multipart：`payload` 为 JSON 字符串，每个文件一个二进制 part。本机路径由宿主替换为 part 引用，桥只接收获准字节。

```json
{
  "protocol": "cardbush.webhook.v1", "type": "tool.call", "eventId": "持久化调用ID",
  "pluginId": "example", "pluginVersion": "1.0.0", "tool": "send_file",
  "arguments": {"file": {"part": "file_0"}},
  "sourceRef": "webhook:来源ID", "messageId": "原始来信ID", "sessionId": "Cardbush上下文ID",
  "senderId": "原始发送人ID", "conversationId": "原始外部会话ID",
  "files": [{"part": "file_0", "name": "report.pdf", "mimeType": "application/pdf", "size": 12345, "sha256": "文件SHA256"}]
}
```

请求头 `X-CardBush-Event-ID` 与 `eventId` 相同，无文件时 `files: []`；`parameters` 包含连接中设置的通用参数。桥必须校验认证、插件版本与参数、原始来信与目标，以及文件数量、大小、SHA-256。禁止用任意新收件人覆盖原始来信，也不要把文件名当任意写入路径。

有副作用的调用须按 `eventId` 持久化去重，相同 ID 内容不同应拒绝。数据保存后才返回 HTTP 2xx：

```json
{"protocol":"cardbush.webhook.v1","eventId":"原样返回调用ID","status":"accepted","result":{"deliveryId":"发送ID","status":"queued","deliveryConfirmed":false}}
```

`result` 是插件自定义 JSON 结果。`accepted` 表示桥已接收，不代表平台送达。结果未知时，使用宿主返回的 `requestId` 作为工具的 `request_id` 重试；Cardbush 保持相同 `eventId`，桥必须去重。两桥的 `delivery_status` 可查询队列；`delivered` 表示平台 API 成功，不表示用户已打开。

普通回复仍用 `message.updated` / `message.completed`。插件发送由显式工具调用触发。旧桥可继续普通对话，但不声明插件就没有文件工具；升级两端迁移，旧 `send_to_bot` 定义不会从保存会话中恢复。

## 验证

`npm run test:context-webhooks` 覆盖宿主、来源、权限、目录隔离、断开和 UI。`npm run test:cli-webhooks` 与 `npm run test:cli-webhook-bridges` 验证实际 CLI Runtime 和独立适配器；后者可用 `CARDBUSH_BRIDGES_DIR` 指定桥项目。

桥项目运行 `npm test` 和 `npm run test:cardbush`。后者依赖相邻已构建 Cardbush，或由 `CARDBUSH_SOURCE_DIR` 指定。测试使用临时目录、随机端口和模拟模型/平台网络，实际执行宿主、工具发现、权限、HTTP、文件字节、平台上传队列和重试逻辑。模拟测试不代替真实账号收件与打开确认。
