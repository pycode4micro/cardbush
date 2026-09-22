# 独立 Agent 服务部署说明

CardBush 内置 `cardbush-agent-deploy` skill，可直接要求 Agent 将服务部署到指定 SSH 主机。该 skill 包含构建、进程托管、更新恢复，以及 SSH 隧道、HTTPS 代理和可选 Fail2ban 防护建议。详见 [部署 skill](../assets/skills/cardbush-agent-deploy/SKILL.md)。

CardBush 可以作为无图形界面的 Node.js 服务运行。每个实例独立管理运行时、模型凭据、插件、项目、会话、任务队列和历史记录。桌面端通过侧栏的 **Agents** 接入多个实例；现有本地聊天、SSH 项目和桌面工具继续使用原有执行流程。

目前由用户分别连接和管理各个 Agent，尚不提供自动集群调度。切换 Agent 不会迁移会话、共享凭据或授予其访问本机桌面工具的权限。后续远程子代理调度可以复用这层连接能力；现有子代理的执行位置不会因此改变。

## 构建与启动

需要 Node.js 22.12 及以上版本、npm 10 及以上版本。在仓库根目录安装依赖、构建并启动：

```sh
npm ci --ignore-scripts
npm run build:agent
node dist-electron/agentServiceCli.mjs --data-dir /srv/cardbush/agent-a --name Agent-A
```

`--ignore-scripts` 可避免在服务器安装依赖时下载 Electron。服务运行时不会导入或启动 Electron。目前构建过程复用仓库内的共享 TypeScript 包，包括编译时使用的 Electron 类型；完成构建后即可运行，无需另外打包桌面安装程序。

首次启动时，为每个实例指定一个**空的独立数据目录**，不要使用桌面端的数据目录。服务会拒绝使用已被其他运行中 Agent 占用的目录，也会拒绝使用已有运行时数据但缺少服务实例标识的目录。实例标识保存在 `agent.json` 中，重启后保持不变。备份时应一起保留该文件以及 `runtime-state`、`config`、`plugins`、`skills` 和 `AGENTS.md`。

HTTP 默认监听 `127.0.0.1:4780`。本机与远程实例都使用直接 HTTP API：`/api/agent/v1/info`、`/api/agent/v1/call` 和 `/api/agent/v1/events`。健康检查为 `/health`，同样需要身份验证。Agent 接入不再提供 MCP 或 stdio；Agent 内部的插件 MCP 连接继续保留。

```sh
node dist-electron/agentServiceCli.mjs \
  --data-dir /srv/cardbush/agent-b --name Agent-B \
  --host 127.0.0.1 --port 4781
```

服务会生成随机访问令牌，写入数据目录下的 `access-token` 文件；在 POSIX 系统上，该文件仅允许所有者访问。也可以通过环境变量 `CARDBUSH_AGENT_TOKEN` 指定至少 32 个字符的令牌。启动日志只显示令牌的**文件路径**，不会打印令牌内容。远程连接应通过反向代理使用 HTTPS。桌面端仅允许对本机回环地址使用明文 HTTP，也可通过 SSH 隧道连接。服务拒绝带有浏览器来源标头的请求，包括 `Origin: null`，不提供浏览器跨域访问例外。

配置反向代理时，保留 `Authorization`、`Accept`、`Last-Event-ID`、`X-CardBush-Agent-ID` 和 `Origin` 请求头，原样转发 `/api/agent/v1/` 下的路径，关闭响应缓冲和缓存。建议读取超时设为 300 秒；事件流每 15 秒发送心跳。不要自动重试会产生副作用的请求。访问令牌代表实例所有者权限，不适合公开分发或用于多租户委托。

## 在 CardBush 中接入

1. 打开 **Agents → 添加 Agent**。
2. 填写服务地址和访问令牌，例如远程 `https://agent.example.com`，本机 `http://127.0.0.1:4780`。不需要选择传输协议。使用代理路径前缀时也可以填写 `https://example.com/agent-a/`，代理需将此前缀去掉后转发到服务。
3. 在**管理此 Agent**中配置模型和 API 密钥，绑定该 Agent 所在主机上的项目目录，并选择默认项目。
4. 开始对话。新会话使用该 Agent 的默认项目；未绑定项目时，会创建独立目录。不同会话可以使用不同项目。

通过 SSH 隧道接入时，`127.0.0.1:14780` 指客户端所在电脑的转发端口。保存 Agent 连接不会创建或维护隧道，项目中的 SSH 连接也不会自动建立端口转发。隧道退出后服务器可能仍正常运行，但客户端无法连接。临时测试可在本机终端运行 `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:14780:127.0.0.1:4780 HOST_ALIAS` 并保持该终端运行；`HOST_ALIAS` 使用实际的系统 SSH 配置别名。长期接入应单独托管隧道或使用 HTTPS 地址。一次 HTTP 检查成功不能证明隧道已经持久运行。

桌面端使用操作系统提供的凭据保护能力加密保存 HTTP 令牌，读取连接列表时不会将令牌返回给界面进程。首次连接成功后，桌面端会绑定持久 Agent ID，并在后续请求中携带该 ID；服务发现身份不一致会在执行操作前拒绝请求。如果同一地址更换为另一个实例，需要重新添加连接。

每个 Agent 都有独立的模型配置、插件安装目录和全局 `AGENTS.md`，不会从本机桌面端复制凭据或插件连接地址。可以从 Agent 所在主机的目录安装或更新插件。例如，在服务器上克隆可选插件仓库，再到该 Agent 的插件设置中填写所需插件的目录。插件生命周期和模型管理复用桌面端的产品管理层（Product Host）；运行时和 MCP 管理也可通过下文中需要身份验证的接口完成。

当前服务 CLI 从数据目录下的 `bundled/skills` 加载内置技能。需要这些技能时，将源码 `assets/skills` 下对应技能的完整目录安装到这里；用户自定义技能放在数据目录下的 `skills`，更新时不要覆盖。服务不会自动加载源码中的技能或复制桌面端插件。

## 本机服务与旧连接迁移

本机也先独立启动 HTTP 服务，再添加地址和令牌。每个实例使用独立数据目录和端口：

```sh
node dist-electron/agentServiceCli.mjs --data-dir /absolute/path/agent-a --name Agent-A --port 4780
```

Windows 上使用 Windows 格式的绝对路径。本机和远程服务都由用户或独立进程管理器托管，关闭 CardBush、移除连接或断开网络不会停止已提交任务。需要停止任务时使用 `chat.stop`；关闭服务进程使用其进程管理器。

已有 MCP HTTP 连接会转换为 HTTP 服务地址，保留令牌与 Agent ID；服务端也必须更新到这个版本，反向代理需同步增加新 API 路由。旧 stdio 连接保留迁移提示，不再执行启动命令；将同一数据目录的服务独立启动为 HTTP 后，重新添加连接即可继续访问历史。`--transport http` 作为旧启动命令的兼容参数保留，`--transport stdio` 会明确报错。

## 任务生命周期与恢复

- `chat.send` 先持久化已接收的任务，再返回结果，随后由服务端队列执行。同一会话内的消息按顺序执行，不同会话可以独立运行。
- `requestId` 用于提交去重，服务重启后仍然有效。重试时必须使用相同 ID 和完全一致的内容；同一 ID 携带不同内容会被拒绝。对于尚未确认提交结果的消息，桌面端在切换 Agent 时仍会保留其提交 ID。
- 关闭传输请求、事件轮询或 HTTP 连接不会停止已经提交的任务。需要停止任务时，应显式调用 `chat.stop`。
- 桌面端通过 SSE 持续接收事件，断线后携带最后收到的 `afterSequence` 续读。其他客户端也可以选择 NDJSON 逐条 JSON 流。接收事件与发送消息独立，权限确认和选项回答不会被事件订阅阻塞。`chat.events` 保留为需要 JSON 批量读取的客户端使用的短轮询接口。
- 服务异常退出后，重启会恢复排队中的消息。此前正在执行的任务标记为 `interrupted`（已中断），不会自动重放，以免重复产生副作用；仍可查看其运行时历史和恢复信息。正常关闭服务时，会停止正在执行的任务，并保留排队消息，等待下次启动。
- 一个服务数据目录只供同一主机上的一个进程使用，不支持通过 NFS 或多个副本并发共享。当前目录锁不提供分布式租约或高可用数据库能力。

## HTTP API 与事件流

所有请求使用 `Authorization: Bearer TOKEN`。管理操作的请求体为 JSON，单次上限 2 MiB：

- `GET /api/agent/v1/info`：获取实例信息，包含 `protocol: "cardbush.agent.v1"`、`apiVersion: 1` 和支持的事件格式。
- `POST /api/agent/v1/call`：直接调用服务业务操作，返回 `{"result": ...}`。失败返回非 2xx 状态和 `{"error":{"code":"...","message":"..."}}`。
- `GET /api/agent/v1/events?sessionId=...&turnId=...`：订阅某个任务的持久事件。指定 `Accept: text/event-stream` 使用 SSE，或 `Accept: application/x-ndjson` 使用流式 HTTP 逐行 JSON。

这里的流式 HTTP 指 HTTP 响应持续输出事件，不是 MCP 的 Streamable HTTP 协议。客户端可在后续请求中传 `X-CardBush-Agent-ID` 绑定实例；不匹配时返回 `409`。API 和事件格式由 CardBush 定义，不使用 MCP 工具调用封装。

创建会话（以下 JSON 均提交到 `/api/agent/v1/call`）：

```json
{"operation":"sessions.create","input":{"sessionId":"work-123","title":"检查项目"}}
```

提交消息（将 `my-model` 替换为已配置的模型 ID）：

```json
{"operation":"chat.send","input":{"requestId":"submission-123","sessionId":"work-123","text":"请检查这个项目","modelId":"my-model","permissionMode":"task_free","language":"zh"}}
```

订阅事件使用 `chat.send` 返回的 `turnId`。首次省略游标即可补读已有记录；断线后传 `afterSequence` 查询参数或 SSE 的 `Last-Event-ID` 请求头，两者同时出现时查询参数优先。游标属于指定会话及轮次，不能跨任务复用。

```http
GET /api/agent/v1/events?sessionId=work-123&turnId=TURN_ID_FROM_CHAT_SEND&afterSequence=12
Authorization: Bearer TOKEN
Accept: text/event-stream
```

两种流使用相同帧结构：`ready`（实例 ID）、`event`（原有 RuntimeEvent）、`end`（最后序号）和 `error`（错误信息）。SSE 使用 `event:` 标记帧类型、`data:` 承载 JSON，事件帧的 `id:` 为序号；心跳为注释。NDJSON 每行一个 JSON 帧，心跳为 `{"type":"heartbeat"}`。收到 `end` 后结束订阅；意外断流按最后已处理序号重连。取消订阅只关闭读连接。

其他操作：

| 类别 | 操作 |
| --- | --- |
| 项目 | `projects.list`、`projects.save`、`projects.remove`、`projects.default` |
| 会话 | `sessions.list`、`sessions.create`、`sessions.get`、`sessions.rename`、`sessions.update`、`sessions.fork`、`sessions.delete`、`sessions.bind` |
| 任务 | `chat.send`、`chat.jobs`、`chat.events`、`chat.stop` |
| 远程子任务 | `delegation.submit`：以任务 ID 去重，在服务器自己的工作区和模型下执行 |
| 会话资源 | `conversation.catalog`、`files.upload`、`files.read`、`files.list` |
| 产品设置 | `product.command`，传入现有产品管理命令，例如 `models.get`、`models.update`、`apps.get`、`apps.update` |
| 插件 | `plugins.install`、`plugins.uninstall`、`plugins.connections`、`plugins.configure` |
| MCP | `mcp.list`、`mcp.configure`、`mcp.remove`、`mcp.reconnect` |
| 指令 | `instructions.get`、`instructions.save`，保存时校验修订版本 |
| 运行时 | `runtime.command { kind, payload }`，用于现有查询、权限、选项、计划和自动化操作 |

任务执行、模型提供方绑定变更和运行时关闭不通过原始运行时命令开放：任务执行统一进入队列，模型变更通过产品管理层完成，进程生命周期由进程管理器负责。事件与快照沿用现有运行时协议，不引入新的 A2A 协议，也不要求 Agent 之间建立固定关系。

## 无图形界面服务的能力范围

服务声明不支持桌面、鼠标控制或 Chrome 图形界面控制。它不会继承桌面端的私有 MCP 连接地址，也不会将请求转发给本机浏览器。可选第三方插件在 Agent 所在主机上运行，需要自行配置依赖和身份验证。服务端不提供桌面登录对话框、交互式凭据提示或图形应用启动能力；请在服务器端配置适用于无图形界面环境的插件连接。

桌面端的远程 Agent 界面复用本机消息组件、输入框、工具记录与授权/提问卡片，支持处理时长、完成时间、复制消息、模型、权限、计划、推理强度、服务器 Skill 与插件命令、附件、流式文本、任务排队与停止、项目绑定及 Agent 设置。授权可选择允许一次、允许本会话、拒绝或取消；提问支持选项、自定义回答和取消。每个 Agent 的草稿、消息反馈、工具展开状态和提问草稿按连接隔离。

会话默认标题从首条可见用户消息恢复，手动标题优先。标题、置顶、归档和已读状态由服务独立持久化，运行中修改这些显示状态不写入模型历史，也不重建 CacheChain。右键菜单支持置顶、标记未读、切换服务器工作区、同一服务器内 Fork、重命名、复制会话 ID／对话、归档及恢复。归档不停止任务，可从该 Agent 下的“查看已归档对话”恢复；删除和切换工作区仍检查任务是否结束。Fork 复制该服务自己的已完成历史，拥有独立 CacheChain，不表示跨 Agent 继承父上下文，也不复制文件。

改动审查复用本机的回合选择、文件树、差异、行评论和撤回／取消撤回。评论先放入当前远程会话草稿，由用户发送；文件树、预览、执行详情和撤回请求全部路由到当前服务器。撤回保留 Runtime 的版本冲突检查，不能覆盖后续用户修改；执行中和有排队任务时禁止撤回。

附件上传到服务器当前会话工作区的 `.cardbush-attachments` 目录，单文件最多 64 MiB，按 512 KiB 分块；重复分块必须内容一致。预览/下载只允许当前工作区内的文件，拒绝越界路径和指向外部的符号链接。图片和文本可只读预览，HTML 等文件不执行。远程路径不会交给本机文件接口。

输入选项与附件依赖服务声明 `conversationUi` 能力，会话显示状态管理和目录浏览依赖 `conversationManagement`。旧版服务继续支持基本对话；请同时更新桌面和服务器程序以启用新增功能。消息编辑重跑、选段提取、桌面专用检查面板、图形界面控制及桌面账号登录尚未完整接入远程界面。

## 通过已连接 Agent 执行子任务

桌面主 Agent 的 `list_subagent_options` 会返回已保存 HTTP 连接的 `remote_agents`。使用 `subagent` 的 `target_agent` 与 `prompt` 即可派发：

```json
{"target_agent":"已保存的连接 ID","prompt":"检查服务器项目的构建失败原因，以中文汇报；不要修改文件。"}
```

子任务使用目标服务器的默认模型、默认项目（无默认项目则创建独立工作区）、插件和指令。父会话历史、本机凭据和文件不自动传输；请在任务描述中提供必要上下文和用户语言。现有权限上限与禁止递归派发的子代理限制仍有效。

派发立即返回任务 ID，结果接入现有 `await_subagents`，支持等待任一或全部结果；用 `resume_task_id` 在原服务器子会话继续。HTTP 确认丢失会按任务 ID 去重，事件流断线按游标续接，取消需要服务器确认。如果无法确认取消，会明确报告失败，不能据此推断远程任务已停止。

子任务详情可打开对应服务器会话查看进度和处理授权。远程授权在该服务器会话中由用户确认，不自动授权，也不伪装成本机路径授权。服务器需声明 `delegation` 能力；旧服务会提示升级。当前此入口由桌面管理的连接目录提供，服务器之间的连接管理及父进程异常退出后的自动重新挂接不在此范围内；服务器已接收的任务仍可在其会话中查看和停止。

## 后台运行与进程托管

在 Linux 上长期部署时，建议通过系统服务管理器运行 Node 命令，使用拥有 Agent 数据目录和项目目录访问权限的普通系统账号。以下是 systemd 服务配置示例：

```ini
[Unit]
Description=CardBush Agent A
After=network-online.target

[Service]
Type=simple
User=cardbush
WorkingDirectory=/opt/cardbush
ExecStart=/usr/bin/node /opt/cardbush/dist-electron/agentServiceCli.mjs --data-dir /srv/cardbush/agent-a --name Agent-A --port 4780
Restart=on-failure
RestartSec=5
TimeoutStopSec=40
UMask=0077

[Install]
WantedBy=multi-user.target
```

本地验证使用真实 Node 工作线程、本机模拟模型和直接 HTTP 客户端，覆盖 SSE、NDJSON、断线续读、身份绑定与任务持久化。运行 `npm run test:agents` 执行服务测试；界面回归脚本为 `scripts/test-agents-ui.cjs`，需要使用仓库中已获系统允许运行的 Electron 可执行文件启动。这些测试不会部署生产服务器。
