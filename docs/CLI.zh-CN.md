# 终端 CLI

[English](CLI.md) · [简体中文](CLI.zh-CN.md)

安装 [npm Agent + CLI 包](NPM_AGENT.md)后，在工作目录中运行 `cardbush`。聊天在本机执行，旧地址和远端环境变量不会改变执行位置；`--local` 保留为兼容参数。

本页描述当前源码。worker 命令与远程聊天入口移除需要新构建，尚未包含在已发布的 npm 1.0.13 中。

## 模型与本机执行

本机连接不需要令牌。CLI 共用应用支持的模型、插件、MCP、网络及沙箱 JSON 配置，但会话单独保存在 `~/.cardbush/cli-agent`。多个本机 CLI 窗口共享一个私有 Runtime，新窗口通常创建独立会话。

没有模型时，按界面展示的路径与示例编辑配置文件，保存后按 Enter。`/settings` 展示路径并重新加载设置，`/model` 选择模型和思考强度，不改变应用默认值。API Key 模型无需应用即可运行；ChatGPT 账号模型复用应用的本机授权桥，需保持应用已登录并运行。详见[模型接入](MODEL_CONNECTIONS.md)及 [SIWC](SIWC_INTEGRATION.zh-CN.md)。

## 启动与恢复会话

```sh
cardbush
cardbush --resume
cardbush --resume SESSION_ID
cardbush --model MODEL_ID
cardbush --prompt "总结工作区里的文件"
cardbush --sessions
cardbush --version
```

`--resume` 不带 ID 时打开交互选择器，列出当前 Runtime / Agent 中跨项目的会话。恢复后沿用该会话的工作区、最后提交的模型与思考强度；`--model` 可以明确覆盖选择。已保存模型不可用时使用当前默认值。

恢复历史展示用户消息与终轮回复，不展开旧工具参数；可通过 `/tools --turn N` 查看。单轮和管道模式的 stdout 只输出新回复。非交互模式不能弹出会话选择器，先用 `--sessions` 查 ID，再显式恢复。

## 输入与快捷键

| 操作 | 方式 |
| --- | --- |
| 空闲时发送 | Enter |
| 执行中排入下一轮 | Enter |
| 立即指导当前任务 | Ctrl+Enter；终端无法区分该组合键时使用 `/steer 文本` |
| 选择建议 | 上下方向键；Enter 确认，Tab 只补全、不发送 |
| 插入文件引用 | 输入 `@`；空格路径加引号，例如 `@"docs/my note.md"` |
| 停止当前任务 | Esc 或 Ctrl+C |
| 清空空闲草稿 | Esc |
| 空闲时退出 | Ctrl+C、`/quit` 或 `/exit` |

长文本和多行粘贴会折叠显示，但完整发送。流式回复到来时保留草稿；审批暂时接管输入，完成后恢复。审批默认选择拒绝，需选择 Allow once 并按 Enter 才允许本次操作。管道模式遇到需要确认的操作会停止，退出码为 2。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/session [ID]`、`/new` | 切换已有会话或新建会话。 |
| `/model [ID]`、`/settings` | 选择模型与思考强度，查看或重新加载配置。 |
| `/tools [number] [--turn N]` | 查看工具名称、参数、执行结果与归档详情。 |
| `/artifact [number]` | 列出或打开本轮生成文件，Tab 选择、Enter 打开。 |
| `/source [number]` | 查看记录中的依据与引用。 |
| `/plan` | 查看当前计划。 |
| `/habit [on\|off\|status]` | 管理当前会话的可选习惯记忆。 |
| `/prediction [on\|off\|status]` | 管理当前会话的下一步预测。 |
| `/browser` | 查看与管理浏览器连接。 |
| `/webhook` | 将外部 Bot 连接到当前会话，支持对话和工具发送文件。 |
| `/logs` | 展示诊断日志路径。 |
| `/shell [COMMAND]`、`!COMMAND` | 执行本机 Shell 命令，退出原生 Shell 后回到对话。 |
| `/help`、`/quit`、`/exit` | 帮助与退出。 |

新会话的习惯与预测默认关闭，恢复时保留，fork 会继承。修改会话、模型、设置或执行本机 Shell 前，应先完成或停止当前任务。执行中的 `/exit` 停止当前观察的任务和本窗口排队消息，其他窗口的队列保留。

支持的终端可以直接点击链接；Windows Terminal 使用 Ctrl+单击下划线链接。无法直接打开时使用 `/artifact`。本机产物直接打开原文件。`/shell` 在 CLI 所在机器上以当前用户执行；远程 worker 路径需要显式授权传输，不能作为本地路径打开。

## 注册远程子 Agent worker

同一本机配置目录的 App 和 CLI 共用 worker 连接。`worker list/add/verify/remove` 直接使用受保护的注册表，不启动整套 Agent Runtime；旧连接迁移时保留 ID。校验成功表示远端服务身份与协议通过，不代表远端已经配置模型；派发真实任务前仍需配置 worker 自己的模型。

```sh
cardbush worker add --name Renderer --url https://agent.example.com --token-file /private/access-token
cardbush worker list
cardbush worker verify CONNECTION_ID
cardbush worker remove CONNECTION_ID
```

让本地 Agent 为返回的连接与已验证实例保存子 Agent 角色，再通过它派发、检查、引导、回答或停止子任务。远端保有独立配置和权限，见[交互协议](SUBAGENT_REMOTE_PROTOCOL.zh-CN.md)。

聊天的 `--url` / `--token-file` 入口已取消，旧连接设置忽略；`--project ID` 选择本机宿主已有项目。安装在服务器上的 CLI 就在该服务器本机运行，但拥有独立会话存储，不会接管另行启动的 HTTP 服务。

同一 npm 包也安装服务命令：

```sh
cardbush serve --background
cardbush serve --status
cardbush serve --stop
cardbush serve --help
```

`cardbush-agent` 是服务入口的别名。默认服务数据在 `~/.cardbush/service`，与本机 CLI 会话数据分开。更新桌面应用不会同时更新 npm 服务。

## Webhook Bot 连接

CLI 与 App 复用同一个通用 Webhook 宿主、自动发现、配对、能力声明和文件协议。微信桥、飞书桥无需修改代码；各平台账号和 SDK 继续留在独立桥服务中。

1. 启动 `cardbush`，新建或恢复想绑定的会话，选择模型和权限。
2. 输入 `/webhook` 启动本机接口。
3. 在另一个终端启动独立 Bot 桥。回到 CLI 选择“刷新”，再选择该服务，即绑定当前会话。
4. 从 Bot 发送文字；需要文件时说“用 send_to_bot 把文件发给我”。

地址和令牌自动交换，不需要填写 JSON。CLI 默认端口为 **4791**。App 和 CLI 保有各自的会话与连接数据，同一端口只由一个宿主监听；使用默认接入流程时，先退出正在占用 4791 的 App 或其他宿主。端口占用会明确提示，不会自动绑定到错误的上下文。

已经绑定过 App 的桥切换到 CLI 时，在桥目录运行 `npm run connect`，重新在 CLI 选择服务，随后 `npm start`。保留原有平台登录信息；桥重新获得 CLI 的连接令牌。

```text
/webhook                 # 发现服务并绑定当前会话
/webhook status          # 查看本机监听和当前会话连接
/webhook disconnect      # 选择并移除当前会话的一个连接
/webhook stop            # 停止这个 CLI Runtime 的所有 Webhook 连接入口，保留配置
/webhook start           # 恢复服务及已保存的绑定
```

连接使用绑定时的模型、思考强度和权限；每次执行重新准备模型，不保存过期的 Runtime provider 引用。需要改用另一模型或权限时重新绑定。Bot 消息进入现有会话队列，保留工作区与历史；终端会显示后台来信任务，等待审批时可在终端处理，不会由桥自动放行。消息来源由宿主附加，`send_to_bot` 按原始来源发送附件，未连接时仍是常驻工具并返回不可用。

启用后，关闭 CLI 窗口不会结束 Webhook 服务。重新运行 `cardbush --resume SESSION_ID` 可以继续观察任务；不再使用时执行 `/webhook stop`。电脑重启后需重新启动 CLI，恢复已保存的连接；这里不安装开机任务。账号模型原有的桌面授权要求不变。

需要 App 与 CLI 同时接入不同 Bot 时，可在 CLI 用 `/webhook port 6112` 指定另一端口，然后在相应桥终端设置 `CARDBUSH_WEBHOOK_URL=http://127.0.0.1:6112`，再运行桥的 `npm run connect`。这是通用端口配置，无须平台专用改动。切换端口后须重新配对以更新地址。

新入口与 App 使用 `/api/webhooks/v1`。旧 `cardbush bots --config …` 继续保留原有 `/api/bots/v1` 接口；微信桥、飞书桥应使用 `/webhook` 流程。文件大小、回执含义和幂等要求见 [通用 Bot 文件协议](WEBHOOK_BOT_PROTOCOL.md)。

源码更新后运行 `npm run build:agent`，停止旧的 Webhook 服务并关闭旧 CLI 窗口，再启动新 CLI。npm 安装用户需要包含此功能的新构建；更新源码不会自动更新全局 npm 包。

## Browser Use

启用 Browser Use，加载 Chrome / Edge 扩展，在 CardBush 扩展流程中批准首次本机连接。应用和本机 CLI 共享连接；外部 Chrome / Edge 不要求应用运行，内置 CardBush 标签页需要应用。

```text
/browser status
/browser retry
/browser pair chrome
/browser pair edge
```

手动配对用于明确指定的连接或远端连接。远端 Agent 保留自己的连接，不继承本机页面授权。连续失败后恢复会暂停：`/browser retry` 重试宿主连接器，扩展中的“连接”重试已保存的扩展连接。临时断线不需要新配对码。详见 [Browser Use](CORE_BROWSER_COMPUTER_USE.md)。

## 诊断与更新

回复进入 stdout，进度和提示进入 stderr。本机诊断日志在 CLI 数据目录的 `logs/runtime.log` 中轮转保存。执行失败查看 `/tools`，宿主诊断查看 `/logs`，分享前去除凭据和私人内容。

运行 `npm install -g cardbush@latest` 后打开新 CLI。源码链接命令在源码更新后需要重新执行 `npm run build:agent`。移除全局安装使用 `npm uninstall -g cardbush`。另见[安装排错](INSTALLATION.zh-CN.md)与[安全边界](../SECURITY.zh-CN.md)。
