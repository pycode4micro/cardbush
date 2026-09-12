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
| 本地导入 | 文件夹与 ZIP；识别包根目录或单一外层目录，按清单 name 安装 | 来源名称可带版本号；不猜选多插件包；ZIP 复用市场路径校验和解压限制 |
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
| MCP 按需发现 | 原生客户端 `tool_search` 与通用 `mcp_search` / `mcp_call` 共用发现和执行系统 | 按实际服务能力协商；不把完整 MCP schema 目录注入模型；搜索只覆盖当前任务范围，不授予执行权限 |
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
- `mcp_search` 默认 `action: "search"`，只返回名称、简短描述和服务标识，不返回或暗中加载 schema。需要使用时以 `action: "load"`、`query: "搜索结果中的准确名称"` 获取一个完整定义；不接受模糊匹配或一次批量加载。完整结果携带定义 revision，并以普通工具消息保存在会话历史。每次模型请求按实际可见上下文恢复已加载定义，因此跨 turn 和重启可以直接复用 `mcp_call`；当前定义、会话归属、工具可见范围和执行权限仍实时检查。搜索结果中的 `loaded: true` 仅表示完整定义仍可从上下文恢复。排序分数只用于内部检索。压缩摘要、归档预览及单独的引用不算完整 schema；大型归档结果只有在通过 `read_archived_tool_result` 完整读取、所有分片仍在上下文中时才可复用。旧发现历史保持原投影，旧调用的准确名称 `reload: true` 仍可解码为 load。schema 变化后追加新定义，旧结果保持不变。模型工具列表在 turn 内冻结，并保留请求中已有的两个发现入口，避免连接增减或恢复改变顶层 schema。
- `search_skills` 返回名称、简短描述和 `mainResource` 中的 SKILL.md 路径；通过既有文件读取工具获取正文，不增加 Skill load 动作。插件技能保留 `invocation`，执行时仍需通过 `run_skill` 应用调用策略、参数和依赖。
- Skill 与 MCP 搜索共用全局默认返回数量，初始 Top 8；在插件页的“设置 → 默认搜索结果数”中修改（1–50 的整数）。单次搜索的 `limit` 优先于默认值，MCP 分页按实际返回数量推进，`action: "load"` 仍只读取一个完整定义。默认值存于已有 `apps.json`，工具执行时读取；修改无需重连 MCP，也不改变工具 schema、提示词或既有历史。未包含该字段的旧配置使用 8，非法值拒绝保存。回归入口：`npm run test:plugin-search-settings`。
- Responses 适配层支持原生客户端 `tool_search`：将搜索调用映射到同一个 `mcp_search` 执行记录，并将其结果投影为 `tool_search_output`。模型随后直接调用已加载的函数，仍经过原工具的作用域、定义 revision、准入、Hooks、超时和取消检查。超过函数名长度限制的工具使用确定性的传输别名，执行与日志继续使用原始名称；别名从实际请求和已读取的 schema 推导，不另存映射表。完整归档结果读取完成后通过 `additional_tools` 加载定义；分片不全或摘要中的工具名称不能代替完整定义。并行批次先提交全部调用结果，再追加标有调用 ID 的搜索说明及归档工具定义，避免中途插入消息令服务端误判结果缺失；增量请求也按完整历史确定批次边界。通用路径继续使用 `mcp_search` / `mcp_call`；两种传输共用同一个目录、历史结果和分片解析器，不保存第二份加载目录。
- 能力协商不按供应商品牌、模型名称前缀或白名单分支。新上下文中，未知能力随正常请求尝试原生协议；只有生成请求在流开始前明确拒绝 `tool_search` 类型，才记录不支持并回退一次。认证失败、限流、网络错误、服务故障及参数 schema 错误不触发该回退。能力观察复用现有按服务配置和模型标识隔离、带有效期的记录；模型标识仅用于隔离观察，不用于推断能力。计数接口是否接受原生工具与生成接口是否支持原生搜索分别记录，计数失败不会关闭生成能力。
- 当前上下文的协议从绑定原始消息的 provider 回放信息恢复，能力记录过期不会中途切换。旧的通用上下文继续使用通用协议，原生流已经开始或原生历史已经建立后不会静默降级、重放执行或改写旧链。这里只保证协议投影和历史连续性；实际服务端缓存命中仍以 provider 返回的 usage 为准。`toolSearch.test.mjs` 使用本地协议服务覆盖能力协商、回退、计数隔离、取消、原生历史回放、混合并行批次、归档读取、重启后复用、权限撤销和实际请求前缀；`pluginContextCache.test.mjs` 覆盖通用路径的会话恢复、schema 更新、权限变更与压缩。
- 流式恢复以共享的输出项索引绑定正文、推理与工具身份；`done` 和最终快照可补齐缺失增量，重复生命周期事件不会重复拼接，矛盾身份或参数在执行前显式失败。取消在每个交付事件前检查，终止事件交付后结束流读取；输出上限仍交给 Runtime 的既有续写流程，截断批次不执行。长函数名在两种协议下都使用相同传输别名；归档分片检查重叠文本一致性，首次完整读取只加载一次定义。对抗用例和验收结果见 [Responses 对抗性测试](RESPONSES_ADVERSARIAL_TESTING.md)。
- `isolation: worktree` 复用现有工作副本模块，需要项目根目录已有 Git 提交。未改动且无后台进程的副本结束后清理；有改动的副本保留用于审查和应用，不自动覆盖原目录。
- Agent 局部 `mcpServers` 支持引用父任务连接和内联 stdio / HTTP 配置。内联定义先审核信任，启动子任务时连接，结束或取消时关闭。OAuth 身份稳定，工具名称按子会话隔离，局部目录不出现在父任务公共工具目录；支持 MCP 服务通配及精确工具规则。需要登录才能发现工具的服务通过既有宿主登录流程处理。
- 后台任务复用 Subagent 执行日志，最多 8 个并发；`manage_plugin_agents` 支持查询、等待和停止。后台结果在下一轮父任务交付，成功提交后标记已交付。运行时重启将无活跃执行者的后台任务标记中断，不重放可能有副作用的操作。父轮次结束后的权限请求走独立宿主表单，关闭与取消会结束等待。
- `permissionMode` 保留父任务权限上限：default 继承，acceptEdits 使用现有工作区文件授权，bypassPermissions 仅在父任务已允许完全控制时有效；dontAsk 拒绝额外授权请求，plan 限制为只读工具。

## MCP 搜索与交互界面

Responses 请求会统一校验顶层工具、`tool_search_output` 和 `additional_tools` 的函数声明。并行搜索、重复 `reload` 或归档读取命中同一工具时，只保留首次声明，仍返回每个调用的结果和搜索说明。参数对象的键顺序不影响判重。定义发生变化时，仅在派生的请求中移除旧声明，在新发现的位置加载新定义；若此次更新涉及已发送的上下文，会放弃旧的 `previous_response_id`、完整重放一次，之后恢复增量续接。持久化的搜索结果不改写。普通重复发现保留既有请求前缀；定义变化造成的缓存失效属于必要更新。

会话失败的主提示按界面语言显示，原始服务商错误保留在可展开的错误详情中。语言规则在固定提示词中约束首次工具调用前的进度说明，给出中文示例并要求纠正后续语言偏移；不逐轮替换系统前缀、不翻译历史消息。提示词能加强语言约束，但不能替代真实模型的遵循性验证。

`mcpToolDiscovery` 只压缩发给模型的工具目录；运行时保留完整且有作用域的权威目录。搜索返回最多 10 项及各自 schema，结果与当前会话、轮次绑定；`mcp_call` 交给原工具的准入、Hooks、超时和取消处理。私有 Agent 工具与仅供界面调用的工具不会出现在父任务搜索中。读取型 Agent 仍可通过这两个入口调用其范围内的只读 MCP 工具。

`mcpAppsHost` 以已记录的工具执行为入口，按 `_meta.ui.resourceUri` 或 `openai/outputTemplate` 读取同一服务的 HTML 资源。支持 `text/html;profile=mcp-app`、旧 `text/html+skybridge` 和 HTML。`McpAppPanel` 提供打开、关闭、内嵌 / 全屏、握手、工具结果、工具调用、资源读取、后续消息和上下文更新；兼容常用 `window.openai` 工具调用、状态、消息与显示 API。

同一界面的工具调用与资源读取由运行时按到达顺序排队，每个请求在实际执行时单独经过权限、Hooks 与执行记录，并收到各自的原始结果或错误。失败不阻断后续请求，也不自动重试。状态查询、授权答复、上下文更新和关闭不进入队列，避免被长请求挡住。取消、关闭或连接失效后，等待中的请求不会再执行；重新加载后的界面不会收到旧实例的迟到答复。连续请求的授权提示按权限 ID 区分，已答复的提示不会因迟到的状态响应再次出现。

界面工具名在当前任务、当前 MCP 服务及所属 Agent 会话范围内解析，优先匹配服务声明的完整名称。无完整匹配时，允许省略一个以 `.` 分隔的前缀，例如 `studio.export-design` 对应短名 `export-design`；短名必须唯一，保留大小写与其余标点。歧义、未找到和未向界面开放分别返回独立错误码；完整名称被禁止时不会转而调用同短名的另一工具。仅供界面的工具也可按此规则调用，原有权限、Hooks、服务端原名和执行记录继续生效。规则适用于所有插件，不改写模型工具目录、提示词或历史记录。

会话通过只读 `describe` 查询已记录执行对应的 UI，自动放在消息的工具输出区，独立于折叠的执行详情。处理中转为完成态保留同一界面；重新进入历史会话只重新读取 UI 资源，不重放原始生成工具。显式 `artifacts`、MCP 媒体块和资源链接也在此展示。终端等工具创建的本地文件由模型在回复中使用 Markdown 文件链接或图片引用展示；需要登记文件事实时，可使用 `remember_file` 返回的备忘录引用，普通交付不要求登记。历史附件继续从原始执行结果渲染，不依赖生成它的工具仍被注册，不从任意工具日志提取“交付物”。

终轮最终回复的图片、音频和视频仅按模型正文中的引用及其原始顺序展示，音视频嵌入显示为播放器。工具产物和独立附件不会在终轮额外生成置顶或末尾媒体区，也不会把正文媒体替换成去重链接；未引用的媒体仍保留在原始记录中。Loop 中的工具媒体放在产生它的工具调用之后，后续文字接在媒体下方；同一文件的后续观察更新已有预览，保留首次出现的位置。流式追加、停止、失败及重新打开执行记录均使用相同排序，正文连续引用的媒体保留源顺序。插件交互界面继续独立挂载，文件编辑汇总保持在最后。

插件详情的示例提示词和连接异常的“交给助手排查”入口会打开可编辑的会话草稿，不自动发送或安装依赖。输入 `$` 可按名称或 ID 选择已安装插件，引用在输入框、已发送消息和重新打开的历史消息中显示插件图标和名称；发送内容保留 `[$plugin-id](<插件清单绝对路径>)`，直接提供可读取的事实来源，不新增全局提示词或修改工具权限。输入框和消息区共用插件目录，按 ID 与清单路径匹配；目录未加载或原插件已不可用时显示通用插件标识，不转成 JSON 文件图标，也不修改已保存的消息。排查提示词携带当前服务 ID、状态和错误快照，由模型读取插件安装说明、检查原因并按插件自身方式处理依赖。

多个界面按实际执行顺序展示，默认只加载最新输出，较早的结果可切换查看；明确选择较早结果后，新输出不会抢走当前选择。界面外层跟随主题，加载占位与内容保持高度，原始错误折叠并提供重试。标题优先使用服务声明的名称，文件编辑汇总放在工具输出之后。主题变化通过桥接通知页面，不重载界面；第三方页面内部样式由插件控制。

内嵌页面使用透明画布和与宿主一致的默认文字/配色，插件自己的 CSS 仍可覆盖这些默认值。`ui.prefersBorder` / `openai/widgetPrefersBorder: false` 时省略内嵌视图的外层边框，避免插件自身圆角外再叠一圈。未主动报告高度的页面按 DOM 尺寸调整内嵌高度（160–900 px）；显式 `notifyIntrinsicHeight` 优先，旧组件无握手的尺寸通知也可生效。展开时按窗口尺寸分配空间，并保留内嵌高度供收起后恢复；超出视口的内容仍在 iframe 内滚动。

“展开视图”将原有 dialog 提升至浏览器顶层，突破消息列表的布局/绘制裁切，原位置保留占位；没有重挂 iframe、重读资源或重放工具，输入、选择和页面临时状态保留。窗口尺寸和展开/收起模式通过标准 Host Context 与 `window.openai` 同步，插件可切换自身布局；支持 Esc 收起。浅色与深色默认文字使用 `CanvasText`，避免插件未指定文字颜色时出现黑底黑字。

插件 iframe 保持 `sandbox="allow-scripts"` 的不透明源。浏览器拒绝 `sessionStorage` 时，桥接提供仅当前页面使用的内存存储，支持 Web Storage 方法及键访问；关闭或重新加载页面即清空，与主界面和其他插件隔离，不开启同源访问、Cookie 或持久化浏览器存储。

页面原生脚本/样式加载失败或未捕获的脚本错误会显示可展开详情与重试入口，并记入界面观察；资源地址去掉查询参数和片段。单张图片加载失败、空结果以及页面内容本身不用于判定任务成败，不自动重放工具，也不修改插件自己的错误处理。

MCP 返回 `isError: true` 时，结果区显示工具返回错误及可展开的原始文本，选择列表标注调用失败，不自动加载该次调用的结果界面。此状态直接来自服务的协议字段；正常的空列表、不含该标记的文本及任意业务字段不会被推断为失败。原始执行记录保留，模型轮次与工具调用行为不变。

界面实例绑定实际 MCP 客户端身份：无关目录重新发布保留活动界面，真实重连或账号替换使旧实例失效。明确的实例过期/连接变化错误最多自动重新读取一次界面资源；持续失败显示重试入口，取消后的迟到结果立即关闭。恢复不重放原始生成工具或用户的界面操作。页面网络使用[全局插件代理](PLUGIN_PROXY.md)。

`mcp_app_status` 返回当前会话内的声明、活动实例，以及 `resource_loading`、`resource_loaded`、`frame_loaded`、`initialized`、`failed`、`closed` 观察。资源加载与 iframe 加载不等于协议握手，更不等于任务完成；历史观察不会伪装成重启后的活动实例。每个会话保留最近 128 条事件，带序号、时间和截断标记。新观察在模型轮次边界追加为内部消息；不修改已有消息、系统提示或工具定义，不因界面状态强制继续一轮模型请求。界面调用仍经过原有权限与 Hooks。

`mcp_search` 的 load 结果把服务声明的 schema / UI 与 `hostCapabilities` 分开返回，宿主能力只说明已提供的界面和本地文件展示入口；普通搜索不重复附带这些完整元数据。上传、导入及文件引用的使用方式保留各工具的原始说明和返回结果；不额外注入上传限制提示、改写调用参数或实现应用专用上传逻辑。

插件通过 `ui/update-model-context` 上报的数据也在当前任务的下一次模型请求前追加并记入会话；未变化的内容不重复追加。它与宿主观察分开标明来源，不能当作宿主确认的结果或用户指令。任务已经结束时，数据留给后续对话；不自动唤醒模型。

MCP 接收层保留服务返回的同一份结果，执行记录与插件界面直接使用；模型和归档读取仅排除 UI 私有 `_meta`，不再增加 `bush.mcp_result.v1`、`facts` 或另一份状态包装。`structuredContent` 可为 null、字符串、数组或对象，不进行补值、包装或文本 JSON 提取；工具 `outputSchema` 与已收到的结果不匹配时不阻断返回。基本协议结构仍须有效，`isError` 与 JSON-RPC 错误保持服务端含义；不能解码的响应保留在错误的 `rawResult` 中。兼容处理只使用当前请求已收到的结果，不重试工具，不解析自然语言来判断任务成败。取消后的迟到响应不交给后续请求；现代协议的交互续传仍由 SDK 处理，不能当作完成结果放行。

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

ZIP、Git 快照与 npm tarball 共用压缩包链接解析器。指向包内普通文件或目录的相对符号链接，以及 tar 中指向包内文件的硬链接，在暂存目录中展开为普通文件/目录；保留目标内容和文件执行位，无需 Windows 符号链接权限，也不改写插件清单或执行插件脚本。安装后的副本不保留链接的实时联动语义。本地目录来源仍沿用原有链接检查。

链接只在压缩包索引中解析，不读取宿主文件系统上的目标。仓库来源以市场条目选定的插件子目录为边界，npm 以 `package/` 为边界，本地 ZIP 以压缩包根为边界。拒绝绝对路径、越界、失效、循环、路径大小写冲突和设备等特殊文件，并在错误中附上相关路径。解析深度和路径数量有限制，链接展开后的副本重复计入 2000 个文件、64 MiB 总量和 10000 项上限；完整验证通过后才写入空暂存目录。

HTTP 429 和带限流响应头的 403 会暂停该域名的后续请求。优先遵守 `Retry-After` 的秒数或 HTTP 日期，API 限额可使用 `x-ratelimit-reset`；未提供有效时间时从 60 秒开始，连续限流逐步延长至 15 分钟。服务端明确给出的更长等待时间不截短。限流响应不缓存为下载成功，也不立即重试或切换下载端点；已经缓存的内容和其他域名仍可使用。普通连接重置及 502/503/504 保留一次有限重试。

界面显示中文或英文等待提示、倒计时和到期可用的重试按钮；到期不自动下载，用户可以继续浏览列表。缓存及冷却状态目前均属于当前主进程，不表示服务端已解除限制。`test:plugin-marketplaces` 验证复用、版本更新、冷却、响应边界及安装快照，`test:plugin-connections` 验证等待期间的交互和窄窗口排版。

## 事件自动化与定时

受信任的原生 command / MCP Tool / HTTP Hook 可通过 `cardbush.activateAgent.prompt` 请求在当前会话排队执行后续任务；界面和 `schedule_task` 共用调度器、执行记录与停止机制。此唤醒扩展独立于 Claude `prompt` / `agent` 的事件审查语义。详见[定时与事件自动化](AUTOMATIONS.md)。

## 账号管理

共享账号在「市场」旁的「账号」入口统一管理；插件详情保留状态与跳转入口。当前接入 OpenAI，复用已有加密凭据与连接；其他平台显示明确的待接入状态。账号管理和每个应用的授权、连接启停各自独立。平台调研、适配器接口与后续多账号方案见[账号中心与多平台接入研究](ACCOUNT_MANAGEMENT.md)。

## 验证

桌面 MCP 配置更新、启用与重连只等待配置受理，连接在后台进行；慢连接不占用配置请求队列。普通服务独立完成、报错和发布工具，每个服务的完整工具目录一次替换；涉及 `required` 服务的更新保留整批成功或回滚的约束。运行中任务只阻止工具目录变更，已完成的连接保留到空闲时发布，不重复握手。后台同时连接的数量默认最多为 4，属于资源限制，不是界面返回的条件。

手动重连只更新目标服务，未变化的已连接、异常或待授权服务及进行中的连接继续复用。新配置、停用、移除与关闭会取消被替代的连接，迟到结果不能覆盖当前配置。快照中的 `updateState` 和 `pendingServerIds` 来自管理器的连接状态，`tools` 始终只描述已发布目录；界面自动读取后台状态，不因连接错误重载应用。内部需要先准备完整目录的调用方（例如独立 Agent）仍可显式等待同一管理器完成，没有另一套连接实现。

`connectionScheduling.test.mjs` 覆盖立即受理、独立发布、慢连接期间的新请求、复用、逐服务失败、取消、迟到结果、关闭及活动任务期间的目录保护。真实 Electron 管理接口测试用受控阻塞的 stdio 子进程验证：配置与其他重连请求在释放该子进程前已经返回，释放后正常发现工具；界面回归验证后台状态自行更新。

同日后台受理改造后的真实插件复测：管理器在 5 ms 内返回 pending，Seedream 与 Blender 在后台约 3047 ms 完成初始化和工具发现，分别返回 3、26 个工具；未执行应用工具。这是一次本机隔离测量，受理耗时不包含界面 IPC 和配置文件读取。

2026-09-10 在同机用真实 Seedream 与 Blender MCP 做隔离连接对照，各模式交替运行 3 次，只执行初始化和工具列表读取；两者每次分别发现 3 和 26 个工具。串行中位耗时 5567 ms，默认并发中位耗时 3333 ms。此结果不包含其他插件、运行中任务等待及完整界面流程，不作为所有环境的连接耗时保证。

`test:plugin-local-install` 覆盖带版本号的来源目录、三种清单格式的 ZIP、外层文件夹、安装后 MCP 路径、异常压缩包与大小限制，以及清单复制期间变更和安装回滚。ZIP 限制为压缩 32 MiB、展开 64 MiB、单文件 16 MiB、2000 个文件；临时目录位于已安装目录之外，导入不修改来源包。`test:plugin-connections` 同时验证 ZIP / 文件夹入口、取消、报错后重试、成功提示和窄窗口排版。

`test:mcp-integration` 覆盖真实本机 OAuth HTTP 服务、PKCE / issuer / 令牌刷新、预设客户端与固定回调端口、配置覆盖、legacy / modern elicitation 归属与取消、用户等待计时、header helper、插件绑定，以及真实 Electron Utility Process 与 safeStorage 的登录、重启恢复和退出。新增首用认证回归覆盖公开工具发现后的 401、同一轮登录后恢复原调用、拒绝 / 取消、并发等待、二次认证失败和配置缺失。测试只使用隔离目录与伪造凭据，不使用真实账户。

`test:plugin-marketplaces` 覆盖现有市场、Git 提交固定、npm 下载参数、异常压缩包与安装快照；`test:plugin-extensions` 覆盖标准包解析、真实 Hook 进程与本地 MCP 服务、并发决策、权限、后台投递/取消、压缩、停止和执行记录。`test:plugin-connections` 验证 Logo 图片解码、配置保存失败、登录取消、表单 / URL 界面及原有信任流程。安装回滚、停用和 Skills/MCP 的原有检查继续保留。

`test-plugin-compatibility.mjs` 随 `test:plugin-extensions` 运行，覆盖 OpenAI 调用策略与 MCP 依赖、同名隔离、手动调用、fork 与 Agent Skills、真实 Runtime 的 prompt / agent Hook、排队工具停止、非合作模型的超时和取消、HTTP Hook、安装后声明变更检查。模型使用可控模拟提供方，HTTP 使用 loopback；这些结果不等同于全部市场插件或真实服务账号均已验收。界面回归验证侧边元数据、调用方式、示例提示词和窄窗口。

`test:plugin-capabilities` 覆盖 MCP 搜索及模型目录投影、局部 Hooks 持久作用域、记忆并发与路径限制、Agent 工作副本、后台结果 / 中断恢复及父轮次结束后的授权。真实 stdio 服务回归验证并行 Agent 连接、OAuth 稳定身份、独立清理、UI 资源及元数据隔离；Electron 界面回归验证 sandbox / CSP、握手、权限、旧 API、上下文、后续消息、窄窗口和关闭。

兼容范围对应上述已接入模块和列明的生命周期事件；不等同于完整复刻两家宿主。LSP 继续排除，Claude 其他宿主专属事件、OpenAI 官方目录发布和平台账号资格另有边界。

2026-09-09 公共服务核验使用官方仓库提交 `d416fd5a43426019986b1e489506db3db66dee3d` 的原始 Linear / Gmail 配置：Linear 返回需要登录，授权元数据提供 DCR 与 PKCE S256；Gmail 未登录时发现 23 个工具，调用 `list_labels` 返回 401，认证元数据来自该响应指定的路径。Gmail 包内客户端 ID 为占位值，CardBush 正确转为需要配置。可用 `node --use-env-proxy scripts/verify-public-plugin-mcp.mjs` 重复公共核验。

真实 Linear 账户登录、真实 Google OAuth 客户端授权及授权后的账户工具调用尚未验收：本轮没有可用的测试账号或 Google 客户端。本机模拟服务通过不代表这些真实账号流程已经通过。

OpenAI 托管路线已于同日用独立 OAuth 和直接 HTTP MCP 验证：目录包含 6 个应用标识，Gmail 发现 21 个工具，成功调用只读 `gmail.get_profile`。未读取邮件、发送邮件或验证其他应用。桌面账户面板、插件选择、加密保存、刷新、取消、退出与账号切换另有隔离回归；未将独立脚本的登录凭据导入桌面。参见[接入与验证说明](OPENAI_HOSTED_CONNECTOR_PROBE.md)。
