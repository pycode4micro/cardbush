# 通过对话接入 CardBush Webhook

Webhook 连接只能绑定所在宿主的 Assistant（`personal-assistant`）。从普通会话发起设置时，告诉用户外部消息将出现在 Assistant。已有微信／飞书桥走下方快捷流程，自建 Bot 或另一个 Agent 走[通用 HTTP 接口](webhook-http.md)。

## 微信和飞书快捷接入

主动事件和对话共用 Assistant 的「连接服务」。可以绑定多个微信号；从外部发起的事件沿原连接和收件人回复，本地事件可在 Assistant 设置中选择默认通知对话。已有 Friends 桥在升级后沿用原令牌、消息回执和来源，无需再次配对。

1. **在运行目标 CardBush 的机器上操作。** App 打开左下角个人资料里的 Webhook 连接；CLI 可在任意交互式会话输入 `/webhook start`。远程 worker 中的 `127.0.0.1` 指向 worker 自己；Assistant 需要执行本机命令时可以委派给有本机工具的子任务。宿主没有终端工具时，把下面的命令交给用户在该机执行。
2. **先检查再启动。** 查看当前轮 `bot_context.connections`（若有），并在本机运行 `cardbush-bridge status weixin --json` 或 `cardbush-bridge status feishu --json`。Assistant 已有同名在线连接时直接验收；已保存但离线时启动原桥。进程已运行时优先检查现有绑定，避免再开一个实例。只读发现请求可确认本机是否有协议宿主：

   ```sh
   curl http://127.0.0.1:4791/api/webhooks/v1/discovery
   ```

   预期响应包含 `protocol: "cardbush.webhook.v1"` 和 `capabilities: ["local_pairing"]`。App 和 CLI 都支持该协议，默认同时只有一个能占用 4791，最终还要核对会话。两者并用时，可在目标 CLI 中输入 `/webhook port 6112`，在桥进程的环境中设置 `CARDBUSH_WEBHOOK_URL=http://127.0.0.1:6112`。已绑定的桥要改投另一个宿主时，先核对原绑定，再按下文重新配对。
3. **只启动用户选的平台。** 已安装时执行下面对应的一条，在完成首次扫码或私密输入前保持交互终端可用。终端工具可保留进程会话时，启动后继续处理配对，等出现需要用户操作的提示再交接。

   ```sh
   cardbush-bridge start weixin
   cardbush-bridge start feishu
   ```

   没有命令时先找已有的独立桥项目；在项目内可用 `node bin/cardbush-bridge.mjs start weixin`（或 `feishu`）。全新安装需要 Node.js 22.13+，在合适的目录执行以下命令，随后回到上面的启动步骤：

   ```sh
   git clone https://github.com/pycode4micro/cardbush-bridges.git
   cd cardbush-bridges
   npm ci --ignore-scripts
   npm link --ignore-scripts
   ```

4. **让用户把本次申请绑定到 Assistant。** App 从侧栏左下角打开「个人资料 → Webhook 连接」，选择刚启动的「微信服务」或「飞书服务」，点击「连接」。CLI 输入 `/webhook`，刷新并选择该服务。斜杠命令由交互式 CardBush CLI 处理，通过普通聊天消息、系统 shell 或 `--prompt` 发送不会执行绑定。当前模型没有直接批准配对的工具。用户只需完成这个宿主动作；地址和令牌由桥交换。Webhook 来信以完全访问权限执行，因此请核对桥和被允许的外部发送者。
5. **完成平台身份验证。** 微信首次用手机扫描桥终端显示的二维码，`wait` 表示仍在等扫码。飞书首次在桥的交互终端填写企业自建机器人 App ID 和 App Secret，保持桥运行，在飞书后台开启长连接并订阅 `im.message.receive_v1`，配置权限、发布应用并把自己纳入可用范围；首次私聊机器人发送“连接 ”加终端中的 8 位配对码。让用户在对应终端或平台处理凭据，不要要求粘贴到对话。平台详细步骤见[微信桥](https://github.com/pycode4micro/cardbush-bridges/blob/main/docs/weixin.md)和[飞书桥](https://github.com/pycode4micro/cardbush-bridges/blob/main/docs/feishu.md)。

## 从用户的消息验收

让用户从目标 Bot 私聊发送一个容易辨认的短句，例如“请原样回复：桥接测试 42”。接着核对三件事：

| 检查点 | 成功的证据 |
|---|---|
| 桥在线 | 个人菜单「Webhook 连接」或 CLI 的 `/webhook status` 显示 `connected`。本机进程在运行、发现接口可读、连接配置已保存分别只证明各自那一步。 |
| 入站和返回 | 用户消息出现在 Assistant，处理该消息的一轮有 `messageSource.kind: "webhook"` 及对应来源。原平台、原聊天收到预期回复。回报最后一个实际验证到的环节。 |
| 用户也要求验收文件 | 从该 Bot 发起小文件测试，使用该条消息的来源搜索桥插件（`mcp_search` → `get_tool_schema` → `call_tool`）。Assistant 可委派子任务。调用桥声明的 `send_file`，回到原聊天核对文件能打开。桥返回 `accepted` 表示已接单，平台接口成功和收件人能打开是不同的验证结果。 |

普通文字由宿主把最终回复送回原会话。Webhook 来信需要补充信息时，在最终回复中直接提问，等待用户下一条消息。媒体或文件操作按实际发现的插件和当前 `sourceRef` 调用；后台任务沿用原始来源。旧的 `send_to_bot` 已移除。

## 卡在哪一步

| 现象 | 下一步 |
|---|---|
| 发现失败或服务列表为空 | 从桥所在机器检查上述发现接口、端口及目标 App / CLI。先启动目标宿主和桥；在 CLI 刷新列表。首次申请约 10 分钟有效，过期重新发起。 |
| 配置已保存但 `offline`，或显示 `disabled` | `offline` 先恢复桥进程和平台账号，再看下一次心跳。`disabled` 表示连接已停用，在 Assistant 的连接设置里启用。桥正常关闭会撤销在线状态，崩溃后租约最多 45 秒过期。 |
| 已连到别的会话或已移除连接 | 用户确实要改绑时停止对应桥，运行 `cardbush-bridge connect weixin` 或 `connect feishu`，在 Assistant 选择新申请，完成后再 `start`。普通重启复用保存的绑定。 |
| `invalid_cardbush_url` 或消息有回执但没有平台回复 | `4791` 是默认宿主端口；微信 `4792/reply`、飞书 `4793/reply` 是桥接收回复的方向。自建桥按[接口文档](webhook-http.md)查询消息回执的 `status`、`errorCode`，再检查回调认证、平台登录和原收件人。 |
| 工具搜索无结果 | 核对 Assistant 绑定、桥心跳、插件声明及宿主返回的 `bridge_plugins`。普通文字收发不要求声明文件工具。 |
