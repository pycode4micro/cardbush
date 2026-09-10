# 当前 CardBush 插件契约

代码依据：`electron/pluginManifest.ts`、`electron/productPlugins.ts`、`electron/pluginMarketplaces.ts`、`electron/pluginAcquisition.ts`、`electron/main.ts`、`packages/cardbush-product-host/src/appsConfigStore.ts`、`src/backend/api.ts`。维护本 skill 时检查这些实现；安装包环境没有源码时，以宿主实际返回和已提供入口为准。

## 包格式与创建

以 OpenAI 当前包规范为基准。新包使用根目录的 Agent Plugins 1.0.0 清单。创建 `example-helper/plugin.json`：

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "example-helper",
  "version": "1.0.0",
  "description": "A local CardBush helper plugin.",
  "author": { "name": "Local developer" },
  "extensions": { "com.openai": { "interface": {
    "displayName": "Example Helper",
    "shortDescription": "A local CardBush helper plugin.",
    "longDescription": "Provides a task-specific helper skill in CardBush.",
    "developerName": "Local developer",
    "category": "Productivity",
    "logo": "./assets/logo.svg"
  } } }
}
```

同时创建实际图标 `assets/logo.svg` 和 `skills/example-helper/SKILL.md`。后者至少具有 `name`、`description` 的 YAML frontmatter 和具体任务指令。替换示例 ID、作者和描述为实际信息，不使用不存在的图标路径。

- 当前 name 校验为 `^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$`，并拒绝 Windows 保留路径名。插件身份和安装目录由清单 name 决定，来源文件夹或 ZIP 名称可以带版本号，无需改名。新包建议使用小写连字符命名。
- 根清单提供身份信息，固定 `skills/` 和 `mcp.json` 提供标准能力；`extensions.com.openai` 提供展示信息与 Hooks。内联 OpenAI 对象存在时，完整替代 `.codex-plugin/plugin.json` 的扩展设置；否则使用该旧文件作扩展回退。扩展不能覆盖根清单身份，也不能改变标准 Skills/MCP 的发现位置。
- 标准 `mcp.json` 声明 `$schema: https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`，在 `mcpServers` 中配置服务，每项显式指定 `type: stdio` 或 `type: streamable-http`。
- 旧 `.codex-plugin/plugin.json` 独立包继续支持相对 Skill 路径、内联或文件形式的 `mcpServers`。`author`、展示信息和图标可选；填写图标路径时文件必须存在。OpenAI 注册的 `apps` 可解析为应用别名和 ID，默认使用 CardBush 独立登录的 OpenAI 账户，也可在插件详情选择包内 MCP、已有服务或服务商地址；不能仅凭注册 ID 宣称已连接。
- 已安装且启用的普通插件 MCP 会由 Runtime 自动加载，支持 stdio、HTTP 和 SSE；服务 ID 为 `plugin_<插件ID>_<服务ID>`（插件 ID 中的点替换为下划线），工具名以宿主实际返回为准。stdio 默认 cwd 为插件根目录，command/args/env/cwd 中可用 `${CARDBUSH_PLUGIN_ROOT}`。普通插件工具默认需要权限检查。Computer Use 和 Chrome 保留专用启动链。app 组件使用同一服务配置与命名空间，托管路线需登录 OpenAI 并在 ChatGPT 授权应用，直连路线需完成连接配置；均须验证实际工具。HTTP / SSE 支持独立 OAuth 登录、刷新与退出；凭据由桌面系统加密保管，不写进模型上下文。
- 单独添加 MCP 连接使用 `cardbush-mcp-management` 和 `mcp__cardbush_management__*` 管理工具。这些工具管理 CardBush MCP 配置，不是通用插件包安装器，也不替代外部软件自己的扩展安装接口。

插件详情提供 `config.mcp_servers.<别名>` 配置：启停、`default_tools_approval_mode`、`enabled_tools`、`disabled_tools`、逐工具 `tools.<工具名>.approval_mode`，以及连接和 OAuth 设置。权限只来自用户配置，包声明不能自行授予调用权限。MCP 的表单和 URL 询问通过桌面弹窗处理，接收输入前校验且保留任务归属；不能伪造用户回答或自动打开 URL 询问。

模型使用 `mcp__cardbush_management__list_plugin_connections` 读取连接别名、实际配置和版本；`configure_plugin_connection` 以 `pluginId`、`componentId`、`expectedRevision` 修改指定连接；`request_plugin_credentials` 打开宿主私密表单并返回保存状态。这些工具由 Product Host 写入既有 Apps 配置，不编辑插件包，不将凭据值返回模型。客户端密钥与令牌复用桌面加密存储，配置只保存绑定服务地址与 client ID 的密钥引用；无需依赖新进程继承环境变量。

## CardBush 自己的目录

- 开发环境公共插件：应用根目录 `assets/plugins`，由其中的 `marketplace.json` 编目。仅在开发内置公共插件时修改该市场文件。
- 个人插件：`app.getPath('userData')/plugins/<id>`；从宿主确定实际 userData，不将某台电脑的用户名、`APPDATA` 推测值或 Codex 目录当成固定路径。
- 插件状态：`userData/product-host/config/apps.json`，由 Product Host 管理。
- 此管理 skill 位于 `assets/skills/cardbush-plugin-management`，使用 CardBush 内置 skill 发现与打包流程。它本身不需要另建插件清单。

## 现有安装与状态接口

本地安装界面调用 `window.cardbushDesktop.installLocalPlugin('directory' | 'zip')`，通过 `plugins:install-local` IPC 打开对应选择器；省略参数时保留目录选择。`installLocalProductPlugin` 为 ZIP 提供限量解压和临时目录清理，并识别根目录或单一外层目录中的插件清单，然后复用 `installProductPlugin` 的校验、复制和安装事务。存在多个候选插件时明确报错，不自行猜选。它不是接受任意路径参数的公开模型工具；不能凭空向它传入 sourcePath。

插件页支持自定义 Git 和本地市场。市场入口优先 `.agents/plugins/marketplace.json`，兼容 `.claude-plugin/marketplace.json` 和内置 `marketplace.json`。仓库地址支持 `owner/repo@ref`、HTTP(S)、SSH URL 和 SCP 形式的 SSH 地址；URL 可用 `#ref` 指定分支、标签或提交。Git URL 使用本机 Git 及其认证配置；不会弹出交互登录窗口。GitHub 简写保留公开 HTTP 下载链。相对包路径从市场根目录解析。

市场条目支持 `local`、`url`、`git-subdir`、兼容 `github` 和 `npm`。Git 条目支持 `ref` / `sha`；npm 条目支持包名、版本/标签/范围和可选 HTTPS registry，通过本机 npm 下载并强制 `--ignore-scripts`，认证沿用 npm 配置。市场添加、刷新、移除与包安装分开，移除来源保留已安装包。这里对齐自定义市场的开放协议；不导入其他宿主的账号目录、登录文件或审批状态。注册连接支持 CardBush 自己的实验性 OpenAI 登录和用户直连配置。当前界面不提供 sparse 参数。

预览、安装及运行使用同一个只读清单解析器。保留原始包文件，不生成转换清单或复制 Skills。Claude 包属于兼容入口，支持既有可加载组件；`strict: false` 的无独立清单包使用安装收据中的原始市场条目。安装收据保存获取来源与原始条目，不存一套改写后的能力定义。MCP 中 `${PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_ROOT}`、`${CODEX_PLUGIN_ROOT}`、`${CARDBUSH_PLUGIN_ROOT}` 都在运行时解析为安装目录；环境变量支持 `${NAME}` 和 `${NAME:-default}`。

以下 Agents 和 Commands 保留为既有兼容能力；标准 Agent Plugins 包不会自动发现这两类目录。新包优先用 Skills 表达可复用流程，不以 Claude 专有能力的完整复刻为目标。安装预览展示实际组件和适配说明：

- **Agents**：读取默认 `agents/` 或清单声明的 Markdown 文件，解析 YAML 中的 `name`、`description`、`tools`、`disallowedTools` 和 `maxTurns`。模型使用 `list_plugin_agents` 发现角色，再调用 `subagent` 的 `agent_type: "plugin:agent"` 应用。角色指令注入子任务，工具范围与父任务已有工具取交集，并应用禁用列表；Claude 的 Read、Write、Edit、Bash 等名称映射到 CardBush 工具。Claude 模型别名不自动切换模型，使用 CardBush 子 Agent 配置。带参数的工具规则、Agent 私有 MCP、隔离、记忆及权限覆盖等专有设置尚不支持。
- **Hooks**：读取 `hooks/hooks.json` 或清单中的内联/文件声明。支持 OpenAI 的 SessionStart、SessionEnd、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PreCompact、PostCompact、Stop、Interrupt、SubagentStart、SubagentStop，并保留既有 PostToolUseFailure。处理器支持 command 和 mcp_tool；prompt / agent 按 OpenAI 当前行为解析后跳过。同一事件的匹配处理器并发执行并合并决定。PreToolUse 错误报告后继续原调用，有效的替换参数仍经过工具校验和宿主准入；PermissionRequest 可以处理即将发起的权限询问，不能覆盖宿主硬拒绝。PostToolUse 的反馈只影响模型收到的结果，原始执行结果完整保留。
- **Commands**：原生读取默认 `commands/` 或清单声明的 Markdown 文件，保留原始文档，不生成 Skill。组件类型为 `command`；输入框 `/插件名:命令名` 菜单显示说明与 `argument-hint`，提交后由宿主调用。模型可通过 `list_plugin_commands` 发现命令、`run_plugin_command` 调用允许自动调用的命令。支持 `$ARGUMENTS`、零起始的 `$ARGUMENTS[n]` / `$n` 和 `arguments` 声明的命名参数；引号内的参数视为一个值。`disable-model-invocation`、`user-invocable` 在宿主校验，停用插件后入口与调用同时失效。

命令文档中的 `!` 加反引号片段和 ` ```! ` 块由宿主在调用时执行，输出注入命令正文，不在安装时执行。支持 Bash（Windows 使用 Git Bash）和显式 PowerShell；参数通过 shell 变量传入，避免作为额外脚本展开。动态步骤先通过原有终端授权，硬拒绝、超时、退出失败和停止取消都保留运行事实。`disallowed-tools` 的普通工具名规则在本轮宿主执行，命令与同批其他工具按顺序处理，下一轮恢复原有范围。`allowed-tools` 原始预授权声明保留并展示，不能覆盖 CardBush 权限设置。动态上下文属于整条命令的运行记录，当前不单独投射成 Bash Hook 事件。每次调用最多 20 个动态步骤，每步 30 秒、输出限 256 KiB。命令的 `context: fork`、私有 Hooks 和带参数的禁用规则仍会提示不兼容；模型沿用当前会话配置。

命令型 Hook 默认使用 Bash（Windows 从本机 Git 安装解析 Git Bash），支持 commandWindows、显式 `shell: "powershell"` / `"cmd"`，或 `command` 加 `args` 数组的直接调用。提供 OpenAI 的 `PLUGIN_ROOT`、`PLUGIN_DATA` 及既有兼容环境变量。OpenAI 包显式声明 Hooks 后替换默认 `hooks/hooks.json` 发现；Claude 兼容包保持其合并规则。默认超时 600 秒，Interrupt / SessionEnd 默认 1 秒并限 1–3 秒；输入限 2 MiB，输出合计限 8 MiB。additionalContextLimit 默认约 2500 token，超出后落盘并提供首尾预览，0 表示不截断上下文。Stop/SubagentStop 的 `continue: false` 结束本轮，`decision: block` 请求继续，显式停止优先；Stop、Interrupt、UserPromptSubmit 忽略 matcher。其他事件按工具名、source、trigger、reason 或 agent_type 匹配。

安装和启用不自动信任 Hook。插件详情中的“Hooks 审核”展示具体定义，用户信任后才会执行；定义或安装位置变更后重新审核。信任哈希属于现有插件配置，不另建事实来源。不要仅凭插件已启用报告 Hook 已运行，也不要通过修改配置文件代替用户对定义的审核。

`mcp_tool` 的 server/tool 指向现有已连接工具，input 支持 `${tool_input.field}` 等模板；完整占位符保留 JSON 类型。Hook 不启动 MCP、不递归触发 Hook、不发起额外权限询问；调用失败只记录错误。后台仅支持 command 的 async，每会话最多同时运行 8 个，其余排队；信息在下一次安全的模型请求中投递，空闲时等下一次用户输入，不能作出控制决定。SessionEnd 同步执行并取消其他后台任务。晚于轮次完成的结果仍写入现有工具记录，不重新开启已结束轮次。

宿主边界：SessionEnd 接入会话删除和 Runtime 正常关闭；切换页面不算结束，没有 Codex 的空闲 30 分钟回收机制。自动压缩会触发 PreCompact / PostCompact 及根会话 SessionStart(compact)，没有手动 clear/compact 入口。MCP elicitation 支持表单和 URL 的桌面交互桥接；transcript_path 为 null，permission_mode 映射为 default / bypassPermissions，并附实际 cardbush_permission_mode。http Hooks、LSP、Channels、Monitors 等不会为了 Claude 兼容而加入。未知可执行声明在市场预览中说明原因并阻止安装；prompt / agent Hook 属于明确的解析后跳过行为。

市场预览先固定 Git 提交并下载到 `userData/plugin-marketplaces/previews`，与已安装目录分离。安装使用预览 token 对应的同一份文件，不重新追踪分支；源信息和提交记录在包内 `.cardbush-marketplace.json`。更新只能替换同一市场来源的包。移除市场来源保留已安装插件。下载或校验不运行包内脚本；实际启用后的 MCP 按现有 Runtime 规则启动，Agents 和 Hooks 在后续任务加载。市场缓存失败回退会明确标注。GitHub 临时连接重置会有限重试，raw 内容读取失败时可回退到 Contents API；网络错误提供代理设置入口。

市场桥接接口依次为 `pluginMarketSources` / `addPluginMarket` / `addLocalPluginMarket`、`pluginMarketCatalog`、`previewMarketPlugin`、`installMarketPlugin`。这些是受宿主限制的界面 IPC，不是已有的模型工具。文件安装后，界面重新读取并保存目标插件的安装/启用状态；启用失败可以重试，不重复安装。保留全局插件服务开关和其他插件状态；全局关闭时需用户从设置启用服务。界面“已安装”不表示 MCP 已连接，应读取实际连接状态。

状态读取是 Product Host 命令 `{ kind: 'apps.get' }`。更新命令形状如下，`current` 必须来自刚读取的当前配置，`targetId` 必须匹配准确插件：

```javascript
const command = {
  kind: 'apps.update',
  config: {
    expectedRevision: current.revision,
    serviceEnabled: current.serviceEnabled,
    plugins: current.plugins.map(plugin => ({
      id: plugin.id,
      installed: plugin.id === targetId ? false : plugin.installed,
      enabled: plugin.id === targetId ? false : plugin.enabled,
      config: plugin.config,
    })),
  },
};
```

这是卸载状态更新的内部契约示例，不是 shell 命令或现成模型工具。安装/启用改为目标的 `true/true`；单独停用只改变 `enabled`。前端已有 `fetchCardbushAppsConfiguration` / `saveCardbushAppsConfiguration`。Skill、插件清单和 MCP 配置目录的变更会通知界面并触发刷新；缺失目录新建后也会自动发现。Skill 搜索每次读取当前文件，保留用户禁用名单。MCP 空闲时应用，有活动 Turn 时自动排队，任务结束后应用，无需手动再次发送消息或重启整个 Runtime。未变更服务保留连接，变更服务重连；普通服务连接失败仅将该服务标为 unavailable，不阻止其他连接。需要 OAuth 登录的服务标为 auth_required；配置校验失败保留原有可用目录并报告错误。当前模型请求已发送的工具列表不会在请求中途被改写，新增 MCP 能力供后续任务使用。

当前管理界面提供安装和启停，没有直接卸载按钮；Runtime 也没有通用插件创建/安装/卸载 Built-in Tool。没有可调用宿主入口时，skill 不能独自补足这个能力。

## 验证

代码工作区使用 `loadProductPluginCatalog` 校验包，再用 `installProductPlugin` 安装到隔离的临时目录，配合 `CardbushAppsConfigStore` 验证安装/停用/卸载状态。测试不要写入真实用户插件目录。

```powershell
npm run test:product-plugins
npm run test:product-skills
npm run test:capability-hot-reload
npm run test:plugin-marketplaces
npm run test:plugin-extensions
npm run test:plugin-commands
npm run test:plugin-connections
npm run test:mcp-integration
```

用户实际安装完成后，重新读取 CardBush 目录/状态；检查启用的插件 skill 根目录或实际 MCP 工具是否出现。卸载后验证该插件的 skill/工具退出发现；独立添加到 MCP 设置中的同名服务不自动视为插件附属资源。
