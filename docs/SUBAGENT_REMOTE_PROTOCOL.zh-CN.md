# subagent-remote-proton

[English](SUBAGENT_REMOTE_PROTOCOL.md) · [简体中文](SUBAGENT_REMOTE_PROTOCOL.zh-CN.md)

**0.1 实验版**已由当前源码的 CardBush HTTP 适配器实现，两端需要重新构建。这是父 Agent 与 worker 的交互契约，尚未验证与独立实现的兼容性。

## 协议选择与边界

学习 MCP 接入能力提供方的方式：父宿主是客户端，明确注册的 worker 是服务端，继续复用 CardBush 现有子 Agent 执行和连接基础。A2A 不作为本设计的依赖、目标适配或发布要求。

参考 MCP 的[版本与能力声明](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)、[消息语义与传输分离](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)，以及[经客户端返回待补充输入](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)的设计。这不代表当前 HTTP 适配器已成为 MCP 服务。MCP 不同修订的生命周期与交互方式不同，后续复用传输时需明确支持的修订，不能假设所有实现都有同一种初始化握手。

协议描述父 Agent 如何通过语言操作独立托管的 worker，不规定工具、插件、模型、文件布局或可执行脚本。宿主适配器负责接入自己的 loop、队列、权限和 UI。

注册赋予 worker 一个职责，不再创建应用里的第二个 assistant。父 Agent 提供任务与必要上下文，子 Agent 保有自己的模型、工作区、凭据和限制。父会话历史、文件、工具目录和凭据不会自动复制；注册也不启用递归派发或子 Agent 之间互聊。

## 复用基础与职责

| 层次 | 已有基础与职责 |
| --- | --- |
| 模型交互入口 | 复用 `subagent` 与 `tasks`，由宿主映射到本地或远程执行；其他宿主不必采用这些工具名。 |
| 子任务生命周期 | 归属、队列/引导、等待、父唤醒及提问/审批 broker 继续由现有 Runtime 管理；连接层不增加第二套调度器或助手 loop。 |
| 连接 | 复用服务身份、私密凭据、HTTP/SSH 路由、事件游标及有界恢复。MCP 客户端的传输、鉴权和生命周期组件是复用候选；绑定工具目录的管理器本身并不是通用子会话管理器。 |
| 线上契约 | 描述消息、进展、待补充输入、回答与明确停止，不依赖模型工具名；远端宿主适配自己的实现。 |

本地和远程子 Agent 已共用归属校验、控制契约和观察投影。`subagent` 在两种宿主都支持显式 queue/insert 和回应交互；`tasks inspect` 返回相同的观察结构，`tasks stop` 精确指向一轮执行。本地排队复用已有任务日志和完成等待器；取消其中一项不会停止前项，也不会让后项越过仍在执行的任务。insert 在安全边界加入引导，不打断当前模型请求或工具。

发现只暴露身份、职责和支持的交互，worker 内部工具目录留在自身 loop。新 worker 声明 `workerInteraction.operations`（`observe`、`queue`、`insert`、`respond`、`cancel`），本地发现返回 `interaction_capabilities`；不支持的操作明确拒绝，不自动降级。未提供可选声明的旧 0.1 worker 沿用该版本规定的完整操作集。结束观察不取消持续工作，停止子任务须有独立操作和确认。

## 身份与注册

| 身份 | 含义 |
| --- | --- |
| service/agent ID | 验证后固定的远端实例身份，不是可变地址或显示名称。 |
| connection ID | 宿主本地的路由与凭据引用，本身不是访问令牌。 |
| role ID + revision | 可复用的名称和指令；子会话存续期间固定原修订。 |
| `contextId` | 子会话，可包含后续多轮执行。 |
| `taskId` | 其中一次执行，引导、回答、停止必须明确指向它。 |
| `messageId` | 变更请求的稳定身份，重试沿用。 |
| `interactionId` | 所属任务中待处理的问题或授权。 |

CardBush 验证服务身份与 `workerInteraction.version = "0.1"`。已注册子 Agent 可配置 `remote: { connection_id, agent_id }`，派发时携带职责名称、指令和修订。远程角色拒绝本地 `allowed_tools`、settings、hooks、guards，避免承诺无法在独立宿主强制执行的规则。续做保留原职责修订；禁用角色阻止继续派发，不暗中停止已经执行的工作。

App 入口为 **Team → 员工 → 远程执行服务**。CLI：

```sh
cardbush worker add --name Renderer --url https://worker.example.com --token-file /private/worker-token
cardbush worker list
cardbush worker verify CONNECTION_ID
cardbush worker remove CONNECTION_ID
```

然后让本地 Agent 将返回的连接与已验证服务 ID 保存成子 Agent 角色；Team 节点引用同一角色。App 与 CLI 当前分别保存连接和凭据，应在执行父 Agent 的宿主上注册；指向另一宿主连接的角色需要重新绑定。发现结果不暴露凭据。CLI 使用私有本地密钥加密，需保护并完整备份服务账号目录；桌面继续使用已有安全存储。

## 交互与消息格式

本版本以生成的 [JSON Schema](protocols/subagent-remote-proton/0.1/README.md) 为格式依据。通用信封示例：

```json
{"profile":"subagent-remote-proton","version":"0.1","contextId":"delegated-child","taskId":"task-1","operation":"observe","after":12,"waitMs":30000}
```

| 操作 | 语义 |
| --- | --- |
| Submit | 用语言创建归属明确的任务，先持久化再确认；当前绑定为 `delegation.submit`。 |
| `message` + `queue` | 在同一子会话排入后续一轮，不替换当前任务。 |
| `message` + `insert` | 将引导交给指定活动任务的下一个安全边界；不中断已经派发的工具，也不在目标结束后偷偷改成新任务。 |
| `observe` | 返回状态、游标、阶段、动作统计和待处理交互；可等待至多 30 秒，不调用模型。 |
| `respond` | 回答问题或提交结构化授权决定。 |
| `cancel` | 请求停止，并明确远端是否已经确认终止。 |

后四类操作在当前绑定中使用 `delegation.control { parentSessionId, control }`。这些 RPC 名称只是适配器实现，不是模型必须提供的工具名。控制消息与问题回答上限为 16,000 字符；通过 `delegation.submit` 提交的新任务上限为 100,000 字符。推荐选项可省略，不限制自由回答。

观察状态包含 `queued`、`working`、`input_required`、`completed`、`failed`、`canceled`、`interrupted`；另有任务内游标、`progress { phase, text, completedActions, failedActions }` 及 `interactions`。通道不返回原始工具参数、结果或私有推理。客户端合并密集事件，使用有界长轮询，不让模型反复调用来轮询。

问题包含 `kind:"question"`、身份、`text`、可选 `suggestions`、`blocking` 和 `createdAt`。回答为 `response: {kind:"answer", interactionId, text}`。CardBush 内部子 Agent 通过 `ask_parent` 适配，其他宿主可使用任何等价 UI、工具或回调。父 Agent 通知复用已有消息唤醒和任务等待机制；回答后继续原子任务。空闲唤醒仍有预算，子消息属于不可信任务材料，不是新增用户授权。

## 权限

授权请求包含 `kind:"permission"`、身份、`text`、`actionDigest`、`operations`、`resources:[{kind,value}]`、`authority`、允许的 `decisions` 及时间字段。摘要绑定精确动作与范围。回答必须使用 `kind:"permission"`、匹配的 `interactionId` 与摘要，以及 `allow_once` 或 `deny`。一句“同意”不是授权；未知、已变化、过期请求或扩大范围的决定都被拒绝。

远端管理员通过 worker 进程环境配置，不能由父消息指定：

```sh
# 以下为默认值
CARDBUSH_REMOTE_PERMISSION_MODE=task_free
CARDBUSH_REMOTE_PARENT_APPROVAL=0
```

请求模式与远端设置的 `task_free`、`user_free` 或 `all_free` 上限取交集；强制沙盒和进程保护继续生效。完全访问只表示该宿主允许的范围，不代表无限权限。

`CARDBUSH_REMOTE_PARENT_APPROVAL=1` 才允许父 Agent 代表远端作一次性审批；默认 `human_required` 拒绝模型批准，仍允许拒绝。需要人类的审批走 worker 所有者现有可信界面；本预览尚未实现跨宿主人类身份签证。父 Agent 不能在 JSON 中自称人类。没有合格审批通道时只能等待、拒绝或取消，不默认放行。

本地适配器复用子 Agent 已有权限路由和审批 broker：`parent` 路由允许委托的一次性决定，`user` 路由仍需人类确认。父日志中的审批按来源子会话与轮次精确筛选，不混入其他子 Agent 或父 Agent 的审批。两种适配器都校验待处理交互和动作摘要，不能扩大原有能力 ID 或资源范围。

当前服务 token 仍是 **owner/admin 管理凭据**，不是限制到某个父 Agent 的委托凭据。只放在可信宿主，通过 HTTPS 或认证 SSH 使用。交互端点检查归属和限制，但不会削减该 token 对其他管理端点的权限。不要向不可信 Agent 分发，也不要把本预览当成多租户委托安全边界。

## 交付、恢复和状态

- 按任务 ID 去重提交，并核对 prompt、父身份、职责、语言、权限模式和 queue 方式；同 ID 不同内容拒绝。
- 消息/回答回执绑定父、context、message ID 与校验后的参数。远端服务先记录接收再执行；崩溃可能留下 `outcome_unknown`，应查询原任务，不能换 ID 重做。本地控制器在内存中去重并发变更，已有持久任务和工具日志仍是执行记录。提供商的 tool-call ID 先按父轮次隔离，再生成消息 ID。
- 回执当前最多 10,000 条，无自动过期。达到上限停止接收新消息/回答变更，观察与幂等停止仍可用；反复停止会查询真实状态，回执满了也不能阻止停止。
- 引导确认区分 accepted 与 applied。`applied:false` 表示等待安全边界，不代表 loop 已经使用文本；当前没有独立、跨宿主的 applied 回执订阅。
- 事件重连沿用原任务与游标。提交/订阅仅对临时错误最多恢复五次并退避；鉴权、身份、schema 错误不无限重试。交互观察连续失败三次后停止；检查任务会重新查询。
- 本地 `unavailable` 只表示观察或停止未确认，不是远端终态，不能显示成完成/停止或自动另起任务。
- 服务重启恢复远端排队任务，活动任务标记中断，不重放不确定副作用。重新打开本地日志后的首次子任务交互，会按已记录终态结算遗留执行；无终态的本地执行和排队项标记停止并注明中断，不自动重放。父进程重启后尚未自动恢复远端交互观察器。
- 所有读取/控制核对父、context、task。Web 网关还绑定登录用户的身份映射并复查授权，只有 ID 不会获得访问权。

## 迁移与后续互通门槛

取消独立 Agents 聊天页与 CLI 远程聊天选择。远端数据保留，已保存地址作为注册子 Agent 的候选连接。本地 CLI（包括在服务器上）仍可对话。连接不再自动复制桌面模型/API 密钥或插件配置。

预览复用子 Agent 注册、Team、任务历史、队列/引导、提问/审批 broker 和父唤醒。Schema 与确定性集成测试覆盖提问、queue/insert、职责/归属、权限上限、重复回执、确认丢失、有界恢复和停止不确定性；这些不等于已与独立实现互通。

相同的父子执行脚本已用于本地 Runtime 和真实 HTTP worker：查看问题、排入两项续做、取消其中一项、插入引导、回答问题并顺序完成。独立测试覆盖审批权限、归属、重复请求、取消观察及日志重开。这些使用确定性模型接口验证执行架构，不评价模型质量。

运行 `npm run test:remote-workers`，可重建适配器并执行协议、Runtime 交互、HTTP 服务、受限 Web 网关和 worker 界面回归。

后续补齐父级作用域凭据、权限词汇、回执保留和过期规则、游标重置、远端交互/观察的持久恢复以及人类决定的可信身份绑定。对外宣称兼容前，用独立 worker 适配器验证已发布 schema 和交互行为。若增加 MCP 绑定，再单独验证所声明 MCP 修订的一致性。产物使用单独授权的传输，远端文件路径不会自动成为本地路径或授权。
