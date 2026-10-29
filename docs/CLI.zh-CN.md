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
| `/logs` | 展示诊断日志路径。 |
| `/shell [COMMAND]`、`!COMMAND` | 执行本机 Shell 命令，退出原生 Shell 后回到对话。 |
| `/help`、`/quit`、`/exit` | 帮助与退出。 |

新会话的习惯与预测默认关闭，恢复时保留，fork 会继承。修改会话、模型、设置或执行本机 Shell 前，应先完成或停止当前任务。执行中的 `/exit` 停止当前观察的任务和本窗口排队消息，其他窗口的队列保留。

支持的终端可以直接点击链接；Windows Terminal 使用 Ctrl+单击下划线链接。无法直接打开时使用 `/artifact`。本机产物直接打开原文件。`/shell` 在 CLI 所在机器上以当前用户执行；远程 worker 路径需要显式授权传输，不能作为本地路径打开。

## 注册远程子 Agent worker

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
