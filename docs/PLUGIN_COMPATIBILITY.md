# 插件支持基线

CardBush 支持 OpenAI 公开插件包与自定义市场，并直接解析 Claude 插件的原始组件。两种来源共享内部执行接口，保留各自的调用和 Hook 结果语义，不生成转换后的 Skill 文件。LSP 按产品范围排除；其他尚未实现的执行声明会在兼容检查中明确报告。

规范核对日期：2026-09-10。

- [OpenAI 包与市场规范](https://developers.openai.com/plugins/build/plugins)
- [OpenAI 插件认证](https://developers.openai.com/plugins/build/auth)
- [Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp)
- [可选的 ChatGPT 交互组件](https://developers.openai.com/plugins/build/chatgpt-ui)
- [OpenAI Hooks](https://learn.chatgpt.com/docs/hooks)
- [OpenAI 的 Claude 迁移范围](https://developers.openai.com/plugins/guides/submit-claude-plugin)
- [OpenAI Skills 可选元数据](https://learn.chatgpt.com/docs/build-skills#optional-metadata)
- [Claude Skills](https://code.claude.com/docs/en/skills)
- [Claude Hooks](https://code.claude.com/docs/en/hooks)
- [Claude Agents](https://code.claude.com/docs/en/sub-agents)
- [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)

## 声明与执行

`electron/pluginManifest.ts` 从原始文件生成只读解析结果。预览、安装、Skills/MCP 发现与扩展执行共用这个解析器，不写转换清单，也不复制另一份 Skills。安装收据只固定来源、版本和原始市场条目。

1. 识别 Agent Plugins 1.0.0 的根 `plugin.json`：身份以根文件为准，Skills/MCP 只来自固定的 `skills/` 和 `mcp.json`。
2. `extensions.com.openai` 是完整的 OpenAI 扩展对象；存在时不读取旧 overlay，不逐字段混合。缺少时回退到 `.codex-plugin/plugin.json` 的扩展配置。
3. 无标准根清单时兼容独立 Codex 清单，然后兼容 Claude 清单。未知 Agent Plugins schema 版本明确拒绝。
4. 原始 Hook 声明保持来源标记；执行结果区分工具拒绝、请求继续与结束本轮。执行事实和权限仍由现有 Runtime 负责。

## 当前能力

| 项目 | 已实现 | 边界 |
| --- | --- | --- |
| 标准包 | 根清单、OpenAI overlay、固定 Skills/MCP、安装事务、`.app.json` 映射 | 标准 schema 1.0.0；注册应用可复用包内同名 MCP，也可由用户配置连接 |
| 自定义市场 | 添加、刷新、缓存回退、移除、快照预览和安装；按固定版本延迟加载 logo / logoDark | 无图或加载失败使用默认图标；npm 包安装前暂不读取展示资产 |
| HTTP / SSE 认证 | OAuth 发现、DCR、PKCE、刷新、退出；预设 client ID、scopes、回调地址 / 端口、资源地址和 CIMD；静态 / 环境变量请求头及 header helper | 直连需要服务方允许独立客户端注册；客户端密钥支持宿主私密录入、加密存储和既有环境变量引用，不读取包内的明文 `client_secret` |
| OpenAI 账户（实验性） | CardBush 独立 OAuth、共享加密凭据、刷新/退出、固定 OpenAI MCP 地址和逐应用工具隔离 | 使用公开客户端注册信息，授权页可能显示 Codex；不依赖 Codex 程序或登录文件；不代表取得第三方宿主正式支持 |
| 插件服务配置 | `mcp_servers.<name>.enabled` / `required`、默认与逐工具审批、工具白名单 / 黑名单、连接与 OAuth 覆盖 | 保存到既有 Apps 配置，不改包内清单；活动任务结束后应用 |
| MCP 交互 | form / URL elicitation、校验、接受 / 拒绝 / 取消、任务归属、等待用户时暂停工具计时；MCP Apps 资源、iframe 和双向 UI 桥接 | 只从产生结果的服务加载声明的 UI；界面工具调用继续经过权限和 Hooks |
| 注册 apps | 读取别名 / 注册 ID / required；同名包内 MCP 合并为一个连接入口；默认使用 OpenAI 托管连接，也支持用户指定绑定或直连地址 | 目标应用需在 ChatGPT 中完成授权；已配置的直连/OAuth/绑定保持优先，用户可明确切换连接方式 |
| 市场认证时机 | ON_INSTALL 安装启用后进入连接设置；普通直连工具遇到认证要求时，弹窗确认后登录并恢复原调用 | 发现阶段不打开浏览器；OpenAI 共享账户重新授权从账户设置发起，并重建连接；不在旧账号会话重放调用 |
| Git | HTTP(S)、SSH、GitHub 简写、本地市场、ref/sha、仓库子目录 | URL 通过本机 Git 认证；简写保留公开 GitHub 下载；不提供 sparse 参数 |
| npm 条目 | 包名、版本/标签/范围、HTTPS registry、npm 配置认证 | 需要本机 npm；下载不运行 lifecycle scripts；安装使用预览生成的原包 |
| Skills | 标准与旧包发现、YAML frontmatter、OpenAI `agents/openai.yaml` 展示与调用策略、MCP 依赖声明、命名空间、原生 `run_skill` | 依赖先连接再执行；`model` / `effort` 沿用 CardBush 配置，不自动选择其他平台模型 |
| Hooks | OpenAI 公开的 12 类事件及 PostToolUseFailure、command / mcp_tool、后台 command、并发合并、定义信任；Claude 增加 HTTP / prompt / agent | OpenAI prompt / agent 仍按其规范跳过；Claude Agent Hook 当前只允许文件读取、搜索；宿主生命周期边界见下文 |
| Agents / Commands | 命名空间、动态上下文、调用策略、maxTurns、Skills 预加载、局部 Hooks、持久记忆、后台运行、worktree 隔离、局部 MCP 和权限模式 | 两种包共用运行模块；平台模型别名继承 CardBush 模型，权限不能超过父任务授权 |
| MCP 按需发现 | `mcp_search` 返回匹配的工具及输入 schema，`mcp_call` 调用已发现的工具 | 不把完整 MCP schema 目录注入模型；搜索只覆盖当前任务权限范围，不授予执行权限 |
| LSP | 安装时明确标记跳过，其余兼容组件可以安装 | 不启动语言服务；市场拒绝没有兼容组件的包；显式依赖 LSP 工具的 Agent 不冒充可执行 |

## Skills 与 Agents

- OpenAI `interface` 的显示名、图标、建议提示词用于技能页面；模型发现使用 SKILL.md 的描述。`policy.allow_implicit_invocation: false` 与 Claude `disable-model-invocation: true` 均阻止模型自动调用，但仍允许用户按声明手动调用。`user-invocable: false` 隐藏手动入口，模型入口另按策略判断。
- 插件技能使用 `plugin:skill` 标识，避免不同插件的同名技能互相覆盖。用户可以输入 `/plugin:skill 参数` 或 `$plugin:skill 参数`；允许手动调用的插件技能也进入输入框的命令列表。模型通过 `search_skills` 发现，再用 `run_skill` 执行。命令和技能保留各自的目录与身份；重名入口在安装检查时拒绝。
- OpenAI `dependencies.tools` 中带地址的 MCP 声明进入现有连接管理；包内同名 MCP 可复用，地址冲突会报告。依赖不会在预览时连接，也不会自动打开登录页。依赖工具未连接、未暴露或技能被任务禁用时，运行明确失败。
- Claude `context: fork` 支持 general-purpose、Explore、Plan 和同插件 Agent。按当前 Claude Skills 语义默认后台运行，`background: false` 等待完成；Agent 自身的 `background: true` 和 `subagent.run_in_background` 也可显式开启后台。沿用配置的子模型和权限，工具范围取父任务、子任务策略和 Agent 声明的交集，嵌套调用上限为 4 层。Explore / Plan 限制为标记为只读的工具。
- Agent 的 `skills` 直接预加载同插件静态技能正文，缺失、被禁用、禁止模型调用或依赖工具不在子任务范围内时拒绝执行。需要动态上下文或再次 fork 的技能不能作为静态预加载项。局部 MCP 连接完成后才检查这些依赖。
- 动态 shell 上下文复用原生命令的参数转义、审批和取消机制；`allowed-tools` 不越过宿主权限，`disallowed-tools` 在执行期间生效。安装、预览和目录浏览不执行脚本。

各能力由独立模块接入：`pluginHookScopes` 负责作用域，`pluginAgentMemory` 负责记忆，`pluginAgentEnvironment` 管理资源生命周期，`pluginBackgroundTasks` 管理后台任务，桌面 `pluginAgentMcp` 只负责 MCP 传输适配。

- Skill / Command 局部 Hooks 在实际调用后激活，并保留到该会话结束；fork 只激活子会话的局部 Hooks。Agent Hooks 仅在对应子任务期间生效，局部 `Stop` 对应 `SubagentStop`。持久化只存激活标识，每次执行重新读取当前定义与信任，停用或修改插件不能沿用旧执行内容。
- Agent `memory: user | project | local` 使用各自的稳定目录。project 保存于项目 `.cardbush/agent-memory/`，user/local 位于运行时数据目录；隔离 Agent 使用原项目的记忆，不写到将被清理的副本。固定提示词只包含记忆使用规则；启动时将 `MEMORY.md` 前 200 行、最多 4 KiB 正文作为带版本的内部输入快照追加到任务后面，和会话记录一同持久化。恢复时重放原快照，不用磁盘最新内容替换历史；已存在的快照不在下一 turn 重复注入，压缩后快照不再可见时可重新加载。`agent_memory_read` 支持文件、行/列游标和关键词定位，单页正文及 JSON 转义文本均限制在 12 KiB，长行可通过 `nextLine/nextColumn` 继续读取。专用 `agent_memory_read/write` 校验路径、符号链接和写入 revision；相同内容写入返回 `unchanged`。磁盘更新通过新的读取结果进入上下文，不改写旧消息。`autoMemoryEnabled: false` 关闭记忆；plan 模式只提供读取。
- MCP 发现结果携带定义 revision，并以普通工具消息保存在会话历史。每次模型请求按实际可见上下文恢复已加载定义，因此跨 turn 和重启可以直接复用 `mcp_call`；当前定义、会话归属、工具可见范围和执行权限仍实时检查。重复 `mcp_search` 只返回未变化工具的简短引用，`reload: true` 可重新返回完整 schema；排序分数只用于内部检索。压缩摘要、归档预览及单独的引用不算完整 schema；大型归档结果只有在通过 `read_archived_tool_result` 完整读取、所有分片仍在上下文中时才可复用。schema 变化后追加新定义，旧结果保持不变。模型工具列表在 turn 内冻结，并保留请求中已有的两个发现入口，避免连接增减或恢复改变顶层 schema。
- 以上优化使用通用函数工具和现有会话日志，不依赖 Responses API 原生 `tool_search`。本地 `CacheChainTracker` 负责检查请求前缀连续性，实际服务端命中仍以 provider 返回的 usage 为准。`pluginContextCache.test.mjs` 覆盖会话恢复、记忆变更、重复发现、schema 更新、权限撤销、授权等待期间换连接，以及上下文压缩/归档分片对工具可见性的影响。
- `isolation: worktree` 复用现有工作副本模块，需要项目根目录已有 Git 提交。未改动且无后台进程的副本结束后清理；有改动的副本保留用于审查和应用，不自动覆盖原目录。
- Agent 局部 `mcpServers` 支持引用父任务连接和内联 stdio / HTTP 配置。内联定义先审核信任，启动子任务时连接，结束或取消时关闭。OAuth 身份稳定，工具名称按子会话隔离，局部目录不出现在父任务公共工具目录；支持 MCP 服务通配及精确工具规则。需要登录才能发现工具的服务通过既有宿主登录流程处理。
- 后台任务复用 Subagent 执行日志，最多 8 个并发；`manage_plugin_agents` 支持查询、等待和停止。后台结果在下一轮父任务交付，成功提交后标记已交付。运行时重启将无活跃执行者的后台任务标记中断，不重放可能有副作用的操作。父轮次结束后的权限请求走独立宿主表单，关闭与取消会结束等待。
- `permissionMode` 保留父任务权限上限：default 继承，acceptEdits 使用现有工作区文件授权，bypassPermissions 仅在父任务已允许完全控制时有效；dontAsk 拒绝额外授权请求，plan 限制为只读工具。

## MCP 搜索与交互界面

`mcpToolDiscovery` 只压缩发给模型的工具目录；运行时保留完整且有作用域的权威目录。搜索返回最多 10 项及各自 schema，结果与当前会话、轮次绑定；`mcp_call` 交给原工具的准入、Hooks、超时和取消处理。私有 Agent 工具与仅供界面调用的工具不会出现在父任务搜索中。读取型 Agent 仍可通过这两个入口调用其范围内的只读 MCP 工具。

`mcpAppsHost` 以已记录的工具执行为入口，按 `_meta.ui.resourceUri` 或 `openai/outputTemplate` 读取同一服务的 HTML 资源。支持 `text/html;profile=mcp-app`、旧 `text/html+skybridge` 和 HTML。`McpAppPanel` 提供打开、关闭、内嵌 / 全屏、握手、工具结果、工具调用、资源读取、后续消息和上下文更新；兼容常用 `window.openai` 工具调用、状态、消息与显示 API。

iframe 使用不共享源的 sandbox，CSP 仅允许资源声明的网络域；默认关闭摄像头、麦克风、地理位置和剪贴板。宿主阻止界面自行跳转到外部页面，页面更换时撤销原界面实例。宿主实例令牌不进入 iframe，消息校验窗口来源；界面不能指定另一 MCP 服务。工具与资源操作经过权限 / Hooks 并写入执行记录，关闭界面取消等待。后续消息和外链在宿主界面确认。UI `_meta` 只保留在原始结果与界面数据中，模型结果不包含它。

OpenAI 托管连接保留当前应用的 app-only 工具，由模型可见性控制隐藏；其他应用的工具和 UI 资源不能借此调用。支付、ChatGPT 专属文件上传 / 下载、平台账号资格等专有宿主 API 不伪造实现。Agent 局部连接随子任务结束关闭，历史界面需要仍然有效的服务连接。

## Hooks 的执行边界

- 事件：SessionStart、SessionEnd、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PreCompact、PostCompact、Stop、Interrupt、SubagentStart、SubagentStop。保留既有 PostToolUseFailure 兼容事件。
- 安装和启用不授予 Hook 信任。插件详情展示原始事件、matcher 和 handler；用户确认具体定义后，将其哈希保存在该插件的现有配置中。定义或安装位置变化后，旧信任失效。执行、预览与设置共用同一个解析结果。
- 同一事件的匹配处理器并发启动，等待后合并；拒绝优先，Stop/SubagentStop 的显式停止优先于继续。PreToolUse 的处理器错误不会被解释为工具拒绝；有效的参数替换仍经过宿主校验和准入。PermissionRequest 仅在实际需要询问权限时运行，不能覆盖宿主硬拒绝。
- mcp_tool 复用已连接 MCP 工具，不启动服务、不递归触发 Hooks、不额外申请权限。执行预算取 Hook 超时与该服务 tool_timeout_sec（默认 60 秒）中的较短者，等待用户填写 elicitation 的时间不计入；不能用于 SessionEnd 或后台处理。普通工具和 Hook 共用同一个交互桥接与取消链路。
- 后台 command 每个会话最多同时运行 8 个，多余排队。只在当前模型请求和工具执行结束后，将已完成的上下文加入下一次模型请求；空闲时等下一次用户输入，不自行开新轮。会话关闭时取消未完成任务、丢弃未投递内容，SessionEnd 始终同步运行。
- 执行事实保存在既有 ToolExecutionStore。工具参数更新后保存实际执行参数，模型原始调用保留在助手消息中。PostToolUse 反馈只替换交给模型的结果，原始结果与副作用完整保留。后台执行可晚于轮次完成，记录照常保存，已关闭的轮次事件流不重开。
- command 默认超时 600 秒；Interrupt / SessionEnd 默认 1 秒，可配置 1–3 秒。支持 commandWindows、PLUGIN_ROOT / PLUGIN_DATA、additionalContextLimit；较大上下文保存完整文件并给模型首尾摘要。命令输入上限 2 MiB，stdout/stderr 合计上限 8 MiB。
- Claude prompt Hook 为独立单轮模型判断，不提供工具；agent Hook 可最多执行 50 轮，只提供父任务中已暴露的 read_file / search_file_content。两者使用当前模型绑定，不递归触发 Hooks；默认超时分别为 30 / 60 秒，取消和超时受宿主约束。结果必须为 `{ok:boolean, reason?:string, impossible?:boolean}`，拒绝时 reason 必填。PreToolUse / PostToolUse prompt 拒绝默认结束本轮，`continueOnBlock` 可保留续轮；agent 拒绝允许后续处理。Stop / SubagentStop 拒绝要求继续，prompt 的 impossible:true 允许结束。处理器错误记录为失败，不等同于一个有效的拒绝决定。同批已经开始的并行工具可能完成，尚未开始的工具不会在结束决定后继续执行。
- Claude HTTP Hook 向指定地址 POST 事件 JSON，响应复用 command 的输出契约。仅支持 HTTP(S)，不跟随重定向；请求头的环境变量只能从 allowedEnvVars 白名单展开。HTTP 输入上限 2 MiB、响应上限 8 MiB，支持超时与取消。HTTP、prompt 和 agent 处理器均需要对具体定义授予信任，不能通过安装直接放行。
- SessionStart 在首次使用或恢复会话时运行，自动压缩后的 compact 事件在立即续轮前运行。压缩前后停止分别位于实际检查点两侧。Interrupt 只来自主任务的主动停止；SessionEnd 接入会话删除和 Runtime 正常关闭，不因切换页面触发。CardBush 当前没有 Codex 的“未打开且空闲 30 分钟”会话回收和手动 clear/compact 入口，不伪造这些事件。
- 工具名称和参数仍以实际工具为准；terminal_exec 使用 Bash 名称，终端轮询不会重复触发 PreToolUse，PostToolUse 等待命令完成。transcript_path 为 null，不伪造 Codex transcript；permission_mode 映射为 default / bypassPermissions，同时提供实际 cardbush_permission_mode。

尚未支持的可执行声明应出现在兼容检查中。新增 OpenAI 能力时扩展内部生命周期接口与结果类型，并增加协议用例。

## MCP 连接与配置

插件详情中的“服务与工具”编辑既有 `apps.json` 中该插件的 `config.mcp_servers`。例如：

```json
{
  "mcp_servers": {
    "docs": {
      "enabled": true,
      "default_tools_approval_mode": "prompt",
      "enabled_tools": ["search", "read"],
      "tools": { "search": { "approval_mode": "approve" } },
      "oauth": { "client_id": "provider-issued-client", "scopes": ["docs:read"] }
    },
    "design": { "server": "my-design-mcp" }
  }
}
```

`docs` 是包内的服务别名；`design` 可以是 `.app.json` 的应用别名，`my-design-mcp` 必须是已配置且启用的独立 MCP 服务。也可使用 `connection.url` 指定服务商地址。绑定复用连接声明，插件仍使用独立的服务命名空间、工具权限和 OAuth 身份，不直接取得另一个宿主的登录状态。修改有版本校验，保存失败保留当前输入；未保存的连接修改不能用于发起登录。

模型可通过 `list_plugin_connections` 读取插件连接及配置版本，再通过 `configure_plugin_connection` 修改指定连接的非密钥设置。`request_plugin_credentials` 使用同一组插件 ID、组件别名和版本打开宿主私密表单；设置界面也提供客户端密钥输入。两个入口复用 Product Host、Apps 配置和运行时连接解析器。并发修改会被版本校验拒绝；保存后连接应用或状态读取失败会保留 `saved: true` 并另报错误。

`.app.json` 与包内 MCP 使用同一个别名是有效声明（例如官方 Linear、Gmail 包）。原始文件保持不变，预览、安装后的目录和设置只显示一个服务，保留注册 ID 与包内连接信息。没有用户直连设置时默认使用 OpenAI 账户；`provider: "openai"` 明确选择托管方式，`provider: "direct"` 明确使用包内或用户直连配置。OpenAI 凭据仅发往固定托管地址，包内地址、请求头和 OAuth 配置不会混入该传输。切换方式保留原有直连配置。

直连时 `connection` 只覆盖指定字段，保留其余包内连接选项。明确选择 `server` 绑定时，以该服务的连接声明为准，不混入包内传输参数或此前输入的地址；绑定缺失或停用时显示不可用，不偷偷切换连接。多个 MCP 配置文件重复声明同一个 MCP 别名仍会拒绝。

包内顶层 `scopes` / `oauth_resource`、包内 `oauth` 与用户 `oauth` 依次合并；每一层先规范化 snake_case / camelCase，用户覆盖不会因拼写不同而失效。`callback_port` 使用 `http://127.0.0.1:<port>/callback`，完整 `callback_url` 优先；资源地址保留 SDK 的来源与路径校验。凭据身份使用规范化后的配置，不随 JSON 字段顺序改变。包中的 `<CLIENT_ID>` 占位值和缺失的密钥环境变量会提示需要配置。

`required` 继承包内声明，用户可在同一连接设置中明确覆盖。必需连接缺少绑定、绑定已停用或缺少地址时，加载会返回具体插件与服务名的错误；不会悄悄省略这个依赖。取消“必需连接”后可按可选服务处理。

OAuth 的浏览器回调使用本机 HTTP loopback，检查 state、回调目标和授权服务器 issuer。凭据经桌面进程使用系统 safeStorage 加密保存在 `userData/mcp-oauth.bin`；无可用的系统加密时返回错误，不退回明文。令牌和 PKCE verifier 不进入模型上下文、公共 Runtime 响应或插件清单；verifier 仅存在于本次登录内存。退出只清除 CardBush 的本机凭据，不代表撤销服务端账户授权。

私密录入的客户端密钥保存在同一个加密文件，普通配置只记录 `clientSecretRef`。引用绑定实际服务地址与 client ID，认证时读取，优先于继承的密钥环境变量，无需重启应用。录入值不经过模型工具参数、工具结果或会话日志；取消和配置冲突会撤销未提交的凭据写入。退出登录清除令牌，保留客户端配置；移除密钥引用不会宣称已删除历史加密条目。本变更不会清理此前通过其他路径写入的会话记录或明文文件。

HTTP header helper 使用当前用户的 shell，在连接需要请求头时运行；输出必须为有限大小的 JSON 请求头对象。每个连接缓存结果，401/403 时重新读取一次。显式请求头优先，凭据不跟随跨源重定向或注入 OAuth 授权服务器地址。市场读取和安装预览不会执行 helper。

交互问题由主进程保存，以服务、任务和轮次绑定。切换会话或重新挂载界面不会改变问题归属；取消原始请求会关闭问题。传统 MCP 协议缺少请求归属标记，涉及交互时同一连接按序调用；现代协议使用原始请求的上下文支持并发。SDK 只在桌面交互桥接可用时声明 elicitation 能力。

连接状态与配置状态分别报告：缺少 OAuth 授权为 `auth_required`，缺少客户端配置为 `configuration_required`，连接失败为 `unavailable`。工具调用阶段才出现的认证错误同样更新状态，包括 SDK 刷新凭据后仍收到的 401。`ready` 表示连接与工具发现成功；部分服务公开工具清单，这本身不证明账户已授权。可选服务失败不阻断其他服务；明确配置 `required` 的运行时服务在普通连接失败时保留整批失败语义，但等待授权或客户端配置是可恢复状态。授权失败不会引发无限重连或应用刷新。

普通工具的实际认证拒绝可触发任务内登录提示，用户接受后通过既有桌面桥接打开授权页面。授权完成后复用当前连接与工具目录，使用原参数恢复调用；同一调用最多触发一次交互登录，其他错误不会因此重放。并发调用共用同一连接的登录流程，任务取消会结束相应等待。设置页手动登录同样经连接管理器更新认证失败状态，界面无论成功或失败都会重新读取状态；旧配置的迟到失败不能覆盖新连接。MCP Hook 调用仅报告认证状态，不自动发起登录。登录提示来自协议错误，不分析用户文本，也不注入模型提醒。

## 市场下载与限流

GitHub 下载按不可变的仓库提交地址复用：同一版本的压缩包、清单和图标在主进程内缓存 30 分钟，总计最多 64 MiB / 256 项，按最近使用顺序淘汰；重启后重新获取。分支查询不使用该缓存，刷新到新提交会获取新快照。相同的并发下载、预览和目录请求会合并；显式刷新不会复用只读缓存查询。网络请求最多同时执行 3 个。安装继续使用用户预览过的暂存快照。

HTTP 429 和带限流响应头的 403 会暂停该域名的后续请求。优先遵守 `Retry-After` 的秒数或 HTTP 日期，API 限额可使用 `x-ratelimit-reset`；未提供有效时间时从 60 秒开始，连续限流逐步延长至 15 分钟。服务端明确给出的更长等待时间不截短。限流响应不缓存为下载成功，也不立即重试或切换下载端点；已经缓存的内容和其他域名仍可使用。普通连接重置及 502/503/504 保留一次有限重试。

界面显示中文或英文等待提示、倒计时和到期可用的重试按钮；到期不自动下载，用户可以继续浏览列表。缓存及冷却状态目前均属于当前主进程，不表示服务端已解除限制。`test:plugin-marketplaces` 验证复用、版本更新、冷却、响应边界及安装快照，`test:plugin-connections` 验证等待期间的交互和窄窗口排版。

## 事件自动化与定时

受信任的原生 command / MCP Tool / HTTP Hook 可通过 `cardbush.activateAgent.prompt` 请求在当前会话排队执行后续任务；界面和 `schedule_task` 共用调度器、执行记录与停止机制。此唤醒扩展独立于 Claude `prompt` / `agent` 的事件审查语义。详见[定时与事件自动化](AUTOMATIONS.md)。

## 账号管理

共享账号在「市场」旁的「账号」入口统一管理；插件详情保留状态与跳转入口。当前接入 OpenAI，复用已有加密凭据与连接；其他平台显示明确的待接入状态。账号管理和每个应用的授权、连接启停各自独立。平台调研、适配器接口与后续多账号方案见[账号中心与多平台接入研究](ACCOUNT_MANAGEMENT.md)。

## 验证

`test:mcp-integration` 覆盖真实本机 OAuth HTTP 服务、PKCE / issuer / 令牌刷新、预设客户端与固定回调端口、配置覆盖、legacy / modern elicitation 归属与取消、用户等待计时、header helper、插件绑定，以及真实 Electron Utility Process 与 safeStorage 的登录、重启恢复和退出。新增首用认证回归覆盖公开工具发现后的 401、同一轮登录后恢复原调用、拒绝 / 取消、并发等待、二次认证失败和配置缺失。测试只使用隔离目录与伪造凭据，不使用真实账户。

`test:plugin-marketplaces` 覆盖现有市场、Git 提交固定、npm 下载参数、异常压缩包与安装快照；`test:plugin-extensions` 覆盖标准包解析、真实 Hook 进程与本地 MCP 服务、并发决策、权限、后台投递/取消、压缩、停止和执行记录。`test:plugin-connections` 验证 Logo 图片解码、配置保存失败、登录取消、表单 / URL 界面及原有信任流程。安装回滚、停用和 Skills/MCP 的原有检查继续保留。

`test-plugin-compatibility.mjs` 随 `test:plugin-extensions` 运行，覆盖 OpenAI 调用策略与 MCP 依赖、同名隔离、手动调用、fork 与 Agent Skills、真实 Runtime 的 prompt / agent Hook、排队工具停止、非合作模型的超时和取消、HTTP Hook、安装后声明变更检查。模型使用可控模拟提供方，HTTP 使用 loopback；这些结果不等同于全部市场插件或真实服务账号均已验收。界面回归验证侧边元数据、调用方式、示例提示词和窄窗口。

`test:plugin-capabilities` 覆盖 MCP 搜索及模型目录投影、局部 Hooks 持久作用域、记忆并发与路径限制、Agent 工作副本、后台结果 / 中断恢复及父轮次结束后的授权。真实 stdio 服务回归验证并行 Agent 连接、OAuth 稳定身份、独立清理、UI 资源及元数据隔离；Electron 界面回归验证 sandbox / CSP、握手、权限、旧 API、上下文、后续消息、窄窗口和关闭。

兼容范围对应上述已接入模块和列明的生命周期事件；不等同于完整复刻两家宿主。LSP 继续排除，Claude 其他宿主专属事件、OpenAI 官方目录发布和平台账号资格另有边界。

2026-09-09 公共服务核验使用官方仓库提交 `d416fd5a43426019986b1e489506db3db66dee3d` 的原始 Linear / Gmail 配置：Linear 返回需要登录，授权元数据提供 DCR 与 PKCE S256；Gmail 未登录时发现 23 个工具，调用 `list_labels` 返回 401，认证元数据来自该响应指定的路径。Gmail 包内客户端 ID 为占位值，CardBush 正确转为需要配置。可用 `node --use-env-proxy scripts/verify-public-plugin-mcp.mjs` 重复公共核验。

真实 Linear 账户登录、真实 Google OAuth 客户端授权及授权后的账户工具调用尚未验收：本轮没有可用的测试账号或 Google 客户端。本机模拟服务通过不代表这些真实账号流程已经通过。

OpenAI 托管路线已于同日用独立 OAuth 和直接 HTTP MCP 验证：目录包含 6 个应用标识，Gmail 发现 21 个工具，成功调用只读 `gmail.get_profile`。未读取邮件、发送邮件或验证其他应用。桌面账户面板、插件选择、加密保存、刷新、取消、退出与账号切换另有隔离回归；未将独立脚本的登录凭据导入桌面。参见[接入与验证说明](OPENAI_HOSTED_CONNECTOR_PROBE.md)。
