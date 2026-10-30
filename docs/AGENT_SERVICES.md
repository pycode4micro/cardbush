# 独立 Agent 服务与远程 worker

[English](AGENT_SERVICES.en.md) · [简体中文](AGENT_SERVICES.md)

本页描述当前源码。已发布安装包可能尚未包含 worker 迁移，需重新构建两端。独立服务拥有自己的 Runtime、模型、工作区、队列和历史；在 App/CLI 中作为注册子 Agent 使用，不再提供独立 Agents 聊天入口，也不自动同步桌面配置或模型密钥。交互和权限契约见 [subagent-remote-proton](SUBAGENT_REMOTE_PROTOCOL.zh-CN.md)。

## 安装与运行

同一个 [npm 包](NPM_AGENT.md)包含服务与 CLI，不需要 Electron。Node.js 24、npm 10+ 与仓库 `.nvmrc`/CI 保持一致。服务器上运行的 `cardbush` 是该服务器的本机 CLI，不接管独立 HTTP 服务的会话数据库。

首次云端部署按内置 cardbush-docs 的[部署流程](../assets/skills/cardbush-docs/references/agent-deploy.md)执行：选定版本与来源（npm/源码/已有包）→ 检查主机资源与沙箱 → 配置指定模型 → 回环服务与 SSH/HTTPS 接入 → 注册职责 → 真实任务与恢复验收。未发布能力可由 Agent 现场从源码构建，不要求用户提前准备压缩包；传输 tarball 时核对前后 SHA-256。`npm latest` 不保证包含当前源码能力。普通用户独立安装目录、Ubuntu AppArmor 和低内存处理见[具体步骤](../assets/skills/cardbush-docs/references/agent-deployment.md)。

```sh
npm install -g cardbush
cardbush serve --background
cardbush serve --status
cardbush serve --stop
cardbush serve --data-dir /srv/cardbush/worker-a --name Worker-A --host 127.0.0.1 --port 4780
# 等价服务入口：cardbush-agent
```

源码部署：

```sh
npm ci --ignore-scripts
npm run build:agent
node dist-electron/agentServiceCli.mjs --data-dir /srv/cardbush/worker-a --name Worker-A
```

`--ignore-scripts` 避免服务器下载 Electron；构建可引用其类型，运行不会启动它。默认服务目录为 `~/.cardbush/service`，本机 CLI 会话目录为 `~/.cardbush/cli-agent`。Windows 使用 Windows 绝对路径。

首次使用独立空数据目录，不要复用桌面数据。目录锁拒绝另一个运行实例，以及缺少实例标识的旧 Runtime 数据。`agent.json` 保留实例身份。备份整个停止后的目录或一致快照，包括 `access-token`、`runtime-state`、`config`、插件/市场、`skills`、`bundled`、`AGENTS.md`；保护级别应与原目录一致。一个目录只允许同机一个进程，不支持 NFS 多副本或分布式租约。

## 网络与身份

默认监听 `127.0.0.1:4780`。随机 token 写入 `access-token`，POSIX 仅 owner 可读；也可用至少 32 字符的 `CARDBUSH_AGENT_TOKEN` 指定。日志只显示文件位置。token 是实例管理凭据，不可公开分发，也不是按父 Agent 隔离的多租户凭据。

远程使用 HTTPS 或认证 SSH；明文 HTTP 只用于回环地址。SSH worker 连接使用 SSH 通道直接连接远端回环 HTTP，不建立本机监听转发端口。SSH 项目则仍由本地 Runtime 执行、仅文件/命令远程，两者不是同一种执行架构。

反向代理保留 `Authorization`、`Accept`、`Last-Event-ID`、`X-CardBush-Agent-ID`、`Origin` 及 `/api/agent/v1/` 路径，关闭缓冲和缓存，读取超时建议 300 秒；事件流约每 15 秒心跳。不要自动重试有副作用的 POST。服务拒绝带 Origin（包括 null）的浏览器请求，不开放 CORS；`/health` 也需要认证。Web 部署通过另有账户边界的私有网关，见[Web 部署](../deploy/web/README.md)。

## 注册及使用

App 在 **Team → 员工 → 远程执行服务** 添加/验证连接，然后保存远程子 Agent 职责。CLI：

```sh
cardbush worker add --name Worker-A --url https://agent.example.com --token-file /private/access-token
cardbush worker list
cardbush worker verify CONNECTION_ID
cardbush worker remove CONNECTION_ID
```

让本地 Agent 将连接 ID 与已验证 agent ID 绑定到注册角色。模型通过既有 `subagent`、`tasks` 和 Team 使用它，不接收 token。同一本机配置目录的 App/CLI 共用受保护的 worker 连接；独立服务器账号继续使用自己的注册表。旧连接迁移一次并保留 ID，worker CLI 命令不启动整套 Agent Runtime。角色和会话仍由各自 Runtime 管理；不能把地址相同的另一个实例当原服务，身份变化后重新确认注册。

部署时完成[分层验收](../assets/skills/cardbush-docs/references/remote-workers.md#分层验收)：连接与角色注册、真实模型委派、原 task_id 续接、沙箱读写与产物独立核验、空闲服务重启后的实例及历史保留。连接成功不等于模型和工具可用；隔离 CLI 的注册不等于日常 App 已配置；进程重启通过不等于开机自启通过。

角色携带名称、指令和修订。远端使用自己的默认模型、默认项目；没有默认项目则创建工作区。父历史、本机路径、浏览器授权与凭据不自动传输。对子会话续做固定原角色和服务身份。远程角色不能配置声称在对端强制执行的本地 tools/settings/hooks/guards。

`subagent({agent_id,prompt})` 开始任务；`task_id` 继续原子会话，`delivery:"queue"` 排入下一轮，`delivery:"insert"` 引导精确活动轮次。`tasks` 负责检查、等待、读取会话和停止。子 Agent 可用文字提问，父回答继续原任务；授权必须结构化。协议本身不要求外部宿主使用这些工具名。

## 权限与宿主配置

worker 默认 `CARDBUSH_REMOTE_PERMISSION_MODE=task_free`，与父请求取较低权限。管理员可设为 `user_free` 或 `all_free`，仍不能绕过 `--sandbox required` 或进程保护。`CARDBUSH_REMOTE_PARENT_APPROVAL=0` 默认要求人类授权，设为 1 才允许父 Agent 在协议限定范围内一次性批准。自然语言、父全权限或自称人类都不是放权依据。审批通道不可用时等待/拒绝/取消，不自动放行。

服务探测现有沙盒，不自动安装。`--sandbox required` 强制上限；`--sandbox off` 是管理员明确策略。Linux bubblewrap、Windows AppContainer 与命令/插件/网页授权是独立边界，见[执行沙盒](EXECUTION_SANDBOX.md)。

模型、MCP、插件、全局指令和网络由 worker 自己配置。按 cardbush-docs 的[部署](../assets/skills/cardbush-docs/references/agent-deploy.md)和[插件管理](../assets/skills/cardbush-docs/references/plugin-management.md)指引明确操作目标。配置管理 API 仍属于受 token 保护的管理面，不表示模型自动获得权限。旧 v2 `configuration.sync` 仅为显式管理兼容保留，连接与派发不自动调用它；OAuth、浏览器登录态和开发机虚拟环境不迁移。

插件市场支持 GitHub 简写、HTTPS/SSH Git 与本地目录。`plugins.marketplace` 提供来源、目录、预览与安装，`pluginMarketplace` capability 决定是否支持；预览身份仅对生成实例有效。网络读取目标 `config/network.json`，缺失时使用进程 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`，直连显式绕过代理。插件 `cardbush.runtime.platforms/requires/mcpServersByPlatform` 按目标实际 OS/账号/依赖解析，SSH 不等于 Linux。

## 生命周期、幂等与恢复

服务先持久化再确认接收；同会话顺序执行，不同会话可并行。提交 ID 与内容绑定，丢失确认时沿用 ID 查询/重试。排队、引导和停止分开；锁定用户队列不撤回已接收的工具或解除权限等待。原任务活动时禁止普通替换派发，显式 queue 才排后续轮。

关闭订阅/断网不等于停止任务。SSE/NDJSON 用原任务游标续读，停止必须明确请求并取得远端确认。重试有预算；耗尽后本地显示 `unavailable`，不能假称远端停止。重启恢复已排队消息，原活动任务记为 `interrupted`，不重放不确定副作用；正常退出停止活动工作并保留队列。父重启后的交互观察器尚未自动重挂，需检查原任务。

不完整或工具身份冲突在执行前拒绝整批，Runtime 追加一次修复提示，仍失败则结束；修复预算随检查点持久化，不重写前缀或重复已执行操作。Goal 续做沿用 Runtime，用户排队消息优先。完整压缩机制见[上下文与记忆](CONTEXT_AND_MEMORY.zh-CN.md)。

## HTTP 管理面与事件

所有请求带 `Authorization: Bearer TOKEN`，调用 JSON 上限 2 MiB：

| 路由 | 用途 |
| --- | --- |
| `GET /api/agent/v1/info` | `cardbush.agent.v1`、API 版本、实例与 capabilities。 |
| `POST /api/agent/v1/call` | `{operation,input}`；成功 `{result}`，失败非 2xx `{error:{code,message}}`。 |
| `GET /api/agent/v1/events?sessionId=...&turnId=...` | `Accept: text/event-stream` 或 `application/x-ndjson`。 |

`X-CardBush-Agent-ID` 固定目标身份，失配返回 409。`afterSequence` 属于指定 session/turn，优先于 SSE `Last-Event-ID`。帧为 `ready`、`event`、`end`、`error`；SSE id 为事件序号，心跳为注释；NDJSON 心跳为 `{"type":"heartbeat"}`。这是当前 CardBush HTTP 绑定，尚未实现 MCP Streamable HTTP 的线上兼容。

| 类别 | 操作 |
| --- | --- |
| worker | `delegation.submit`、`delegation.control`，版本见交互规范。 |
| 项目与历史 | `projects.*`、`sessions.*`、`chat.jobs/events/stop/queue`。 |
| 兼容管理对话 | `chat.send`，仅管理 API 保留，不恢复 App/CLI 直连入口。 |
| 资源 | `conversation.catalog/extracts`、`files.upload/read/list/pasted-text`。 |
| 配置 | `product.command`、`instructions.get/save`（修订校验）。 |
| 插件/MCP | `plugins.*`、`mcp.list/configure/remove/reconnect`。 |
| Runtime | `runtime.command` 的允许查询和交互；执行统一进队列，不能通过它启动第二套 loop 或关闭宿主。 |

附件传输保留 64 MiB/文件、512 KiB 分块，重复分块必须一致。资源读取限所属工作区，拒绝越界路径和外部符号链接；远程路径不交本机文件 API。HTML 在隔离源读取相对资源，不访问 Node、凭据或本机文件。产物交付须显式传输，不因模型写出路径就自动下载。

## 图形能力、部署与更新

默认 Node 服务无需桌面/浏览器/Docker，不提供桌面登录弹窗或继承本机插件会话。需要图形操作可显式部署 [Docker Linux 桌面](../deploy/agent/README.md)：

```sh
docker compose -f deploy/agent/compose.yaml up --build -d
# 可选同一 worker 的图形桌面
docker compose -f deploy/agent/compose.yaml -f deploy/agent/compose.desktop.yaml up --build -d
```

桌面、浏览器 profile 与数据卷归同一 worker，独立用户用独立容器/卷。Linux 长期运行可由普通服务账号的 systemd 托管，使用 `Restart=on-failure`、适当退出超时和 `UMask=0077`。已有旧 stdio 连接只保留迁移提示，不再执行其启动命令；显式部署 HTTP 服务后重新注册。`--transport http` 保留兼容，stdio 拒绝。

更新服务和 CLI 程序不更新已运行进程，也不替换桌面 App。保留数据，待任务安全结束再重启。内置技能随发行资源更新到 `bundled/skills`；用户 `skills` 另保留。工具 schema、loop 与产品指令来自构建代码，修改 JSON 或同步设置不能代替升级。通过目标的工具目录和版本核对真正生效的构建。

验证：`npm run test:agents`、`npm run test:remote-workers`、`npm run test:agents-ui`、`npm run test:agent-chat`。使用隔离 Node Worker、模拟模型、真实本机 HTTP/CLI 和 UI，不部署生产服务。独立 worker 适配器需要另做交互契约验证；后续若增加 MCP 绑定，还需验证所声明修订的一致性。
