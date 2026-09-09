# 插件支持基线

CardBush 以 OpenAI 的公开插件包与自定义市场协议为基准。Claude 清单是既有兼容入口；新增能力按 OpenAI 规范和 CardBush 实际需求推进，不追求复制 Claude 的整个扩展系统。

规范核对日期：2026-09-09。

- [OpenAI 包与市场规范](https://developers.openai.com/plugins/build/plugins)
- [OpenAI 插件认证](https://developers.openai.com/plugins/build/auth)
- [Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp)
- [可选的 ChatGPT 交互组件](https://developers.openai.com/plugins/build/chatgpt-ui)
- [OpenAI Hooks](https://learn.chatgpt.com/docs/hooks)
- [OpenAI 的 Claude 迁移范围](https://developers.openai.com/plugins/guides/submit-claude-plugin)

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
| MCP 交互 | form / URL elicitation、校验、接受 / 拒绝 / 取消、任务归属、等待用户时暂停工具计时 | 不执行服务返回的 HTML；MCP Apps iframe 组件仍未接入 |
| 注册 apps | 读取别名 / 注册 ID / required；同名包内 MCP 合并为一个连接入口；默认使用 OpenAI 托管连接，也支持用户指定绑定或直连地址 | 目标应用需在 ChatGPT 中完成授权；已配置的直连/OAuth/绑定保持优先，用户可明确切换连接方式 |
| 市场认证时机 | ON_INSTALL 安装启用后进入连接设置；普通直连工具遇到认证要求时，弹窗确认后登录并恢复原调用 | 发现阶段不打开浏览器；OpenAI 共享账户重新授权从账户设置发起，并重建连接；不在旧账号会话重放调用 |
| Git | HTTP(S)、SSH、GitHub 简写、本地市场、ref/sha、仓库子目录 | URL 通过本机 Git 认证；简写保留公开 GitHub 下载；不提供 sparse 参数 |
| npm 条目 | 包名、版本/标签/范围、HTTPS registry、npm 配置认证 | 需要本机 npm；下载不运行 lifecycle scripts；安装使用预览生成的原包 |
| Hooks | OpenAI 公开的 12 类事件、command / mcp_tool、后台 command、并发合并、定义信任和事件输出契约 | prompt / agent 解析后跳过，与 OpenAI 一致；宿主生命周期边界见下文 |
| Agents / Commands | 已有旧格式组件的执行入口 | 保留兼容；不自动发现为标准包组件，不新增 Claude 私有能力 |

## Hooks 的执行边界

- 事件：SessionStart、SessionEnd、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PreCompact、PostCompact、Stop、Interrupt、SubagentStart、SubagentStop。保留既有 PostToolUseFailure 兼容事件。
- 安装和启用不授予 Hook 信任。插件详情展示原始事件、matcher 和 handler；用户确认具体定义后，将其哈希保存在该插件的现有配置中。定义或安装位置变化后，旧信任失效。执行、预览与设置共用同一个解析结果。
- 同一事件的匹配处理器并发启动，等待后合并；拒绝优先，Stop/SubagentStop 的显式停止优先于继续。PreToolUse 的处理器错误不会被解释为工具拒绝；有效的参数替换仍经过宿主校验和准入。PermissionRequest 仅在实际需要询问权限时运行，不能覆盖宿主硬拒绝。
- mcp_tool 复用已连接 MCP 工具，不启动服务、不递归触发 Hooks、不额外申请权限。执行预算取 Hook 超时与该服务 tool_timeout_sec（默认 60 秒）中的较短者，等待用户填写 elicitation 的时间不计入；不能用于 SessionEnd 或后台处理。普通工具和 Hook 共用同一个交互桥接与取消链路。
- 后台 command 每个会话最多同时运行 8 个，多余排队。只在当前模型请求和工具执行结束后，将已完成的上下文加入下一次模型请求；空闲时等下一次用户输入，不自行开新轮。会话关闭时取消未完成任务、丢弃未投递内容，SessionEnd 始终同步运行。
- 执行事实保存在既有 ToolExecutionStore。工具参数更新后保存实际执行参数，模型原始调用保留在助手消息中。PostToolUse 反馈只替换交给模型的结果，原始结果与副作用完整保留。后台执行可晚于轮次完成，记录照常保存，已关闭的轮次事件流不重开。
- 默认超时 600 秒；Interrupt / SessionEnd 默认 1 秒，可配置 1–3 秒。支持 commandWindows、PLUGIN_ROOT / PLUGIN_DATA、additionalContextLimit；较大上下文保存完整文件并给模型首尾摘要。命令输入上限 2 MiB，stdout/stderr 合计上限 8 MiB。
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

## 验证

`test:mcp-integration` 覆盖真实本机 OAuth HTTP 服务、PKCE / issuer / 令牌刷新、预设客户端与固定回调端口、配置覆盖、legacy / modern elicitation 归属与取消、用户等待计时、header helper、插件绑定，以及真实 Electron Utility Process 与 safeStorage 的登录、重启恢复和退出。新增首用认证回归覆盖公开工具发现后的 401、同一轮登录后恢复原调用、拒绝 / 取消、并发等待、二次认证失败和配置缺失。测试只使用隔离目录与伪造凭据，不使用真实账户。

`test:plugin-marketplaces` 覆盖现有市场、Git 提交固定、npm 下载参数、异常压缩包与安装快照；`test:plugin-extensions` 覆盖标准包解析、真实 Hook 进程与本地 MCP 服务、并发决策、权限、后台投递/取消、压缩、停止和执行记录。`test:plugin-connections` 验证 Logo 图片解码、配置保存失败、登录取消、表单 / URL 界面及原有信任流程。安装回滚、停用和 Skills/MCP 的原有检查继续保留。

2026-09-09 公共服务核验使用官方仓库提交 `d416fd5a43426019986b1e489506db3db66dee3d` 的原始 Linear / Gmail 配置：Linear 返回需要登录，授权元数据提供 DCR 与 PKCE S256；Gmail 未登录时发现 23 个工具，调用 `list_labels` 返回 401，认证元数据来自该响应指定的路径。Gmail 包内客户端 ID 为占位值，CardBush 正确转为需要配置。可用 `node --use-env-proxy scripts/verify-public-plugin-mcp.mjs` 重复公共核验。

真实 Linear 账户登录、真实 Google OAuth 客户端授权及授权后的账户工具调用尚未验收：本轮没有可用的测试账号或 Google 客户端。本机模拟服务通过不代表这些真实账号流程已经通过。

OpenAI 托管路线已于同日用独立 OAuth 和直接 HTTP MCP 验证：目录包含 6 个应用标识，Gmail 发现 21 个工具，成功调用只读 `gmail.get_profile`。未读取邮件、发送邮件或验证其他应用。桌面账户面板、插件选择、加密保存、刷新、取消、退出与账号切换另有隔离回归；未将独立脚本的登录凭据导入桌面。参见[接入与验证说明](OPENAI_HOSTED_CONNECTOR_PROBE.md)。
