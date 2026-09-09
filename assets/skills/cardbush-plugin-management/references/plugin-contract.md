# 当前 CardBush 插件契约

代码依据：`electron/productPlugins.ts`、`electron/pluginMarketplaces.ts`、`electron/pluginManifestImport.ts`、`electron/main.ts`、`packages/cardbush-product-host/src/appsConfigStore.ts`、`src/backend/api.ts`。维护本 skill 时检查这些实现；安装包环境没有源码时，以宿主实际返回和已提供入口为准。

## 包格式与创建

最小示例是一个仅带 skill 的插件。创建 `example-helper/.codex-plugin/plugin.json`：

```json
{
  "name": "example-helper",
  "version": "1.0.0",
  "description": "A local CardBush helper plugin.",
  "author": { "name": "Local developer" },
  "skills": "./skills",
  "interface": {
    "displayName": "Example Helper",
    "shortDescription": "A local CardBush helper plugin.",
    "longDescription": "Provides a task-specific helper skill in CardBush.",
    "developerName": "Local developer",
    "category": "Productivity",
    "logo": "./assets/logo.svg"
  }
}
```

同时创建实际图标 `assets/logo.svg` 和 `skills/example-helper/SKILL.md`。后者至少具有 `name`、`description` 的 YAML frontmatter 和具体任务指令。替换示例 ID、作者和描述为实际信息，不使用不存在的图标路径。

- 当前 name 校验为 `^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$`；本地安装还要求包目录名与 name 相同。新包建议使用小写连字符命名。
- OpenAI 格式是内部标准。`author`、`interface` 和图标为可选展示信息；填写了图标路径时，文件必须存在。
- `skills` 当前为一个相对目录字符串，目录下每个子目录是一个 skill 包。
- `mcpServers` 可为内联对象或指向 JSON 文件的相对路径；`apps` 为指向 app 配置文件的相对路径。只添加当前任务需要的组件，并检查对应文件及实际加载链。
- 已安装且启用的普通插件 MCP 会由 Runtime 自动加载，支持 stdio、HTTP 和 SSE；服务 ID 为 `plugin_<插件ID>_<服务ID>`（插件 ID 中的点替换为下划线），工具名以宿主实际返回为准。stdio 默认 cwd 为插件根目录，command/args/env/cwd 中可用 `${CARDBUSH_PLUGIN_ROOT}`。普通插件工具默认需要权限检查。Computer Use 和 Chrome 保留专用启动链。app 组件的目录展示仍不等于通用执行接入，必须验证实际入口。
- 单独添加 MCP 连接使用 `cardbush-mcp-management` 和 `mcp__cardbush_management__*` 管理工具。这些工具管理 CardBush MCP 配置，不是通用插件包安装器，也不替代外部软件自己的扩展安装接口。

## CardBush 自己的目录

- 开发环境公共插件：应用根目录 `assets/plugins`，由其中的 `marketplace.json` 编目。仅在开发内置公共插件时修改该市场文件。
- 个人插件：`app.getPath('userData')/plugins/<id>`；从宿主确定实际 userData，不将某台电脑的用户名、`APPDATA` 推测值或 Codex 目录当成固定路径。
- 插件状态：`userData/product-host/config/apps.json`，由 Product Host 管理。
- 此管理 skill 位于 `assets/skills/cardbush-plugin-management`，使用 CardBush 内置 skill 发现与打包流程。它本身不需要另建插件清单。

## 现有安装与状态接口

本地安装界面调用 `window.cardbushDesktop.installLocalPlugin()`，通过 `plugins:install-local` IPC 打开目录选择器，再由 `installProductPlugin(sourcePath, userPluginRoot)` 校验并复制。它不是接受任意路径参数的公开模型工具；不能凭空向它传入 sourcePath。

插件页的“市场”或“添加 → 从市场安装插件”支持添加公开 GitHub 仓库和本地市场根目录。GitHub 可输入 `owner/repo`、`owner/repo@ref` 或仓库 URL。市场入口识别 `.agents/plugins/marketplace.json`、`.claude-plugin/marketplace.json` 和内置的 `marketplace.json`；相对包路径从市场根目录解析。当前下载来源支持仓库内子目录及 GitHub 的 `url`、`git-subdir`、`github` 条目，不支持 npm、私有仓库、其他 Git 托管服务或 OpenAI 账号专属连接器市场。

市场导入保持 OpenAI 清单为内部标准：原生读取 `.codex-plugin/plugin.json`，Claude 包读取 `.claude-plugin/plugin.json` 后转换；市场条目明确设置 `strict: false` 时也可使用条目描述无独立清单的包。支持 Skills 路径数组、默认 `skills/`、`.mcp.json`、内联 MCP 和标准 stdio/HTTP/SSE MCP。MCP 中 `${CLAUDE_PLUGIN_ROOT}` / `${CODEX_PLUGIN_ROOT}` 转换为安装后的插件目录；环境变量支持 `${NAME}` 和 `${NAME:-default}`，未设置且无默认值时预览会提示。

新增能力按以下边界运行，安装预览会展示组件和适配说明：

- **Agents**：读取默认 `agents/` 或清单声明的 Markdown 文件，解析 YAML 中的 `name`、`description`、`tools`、`disallowedTools` 和 `maxTurns`。模型使用 `list_plugin_agents` 发现角色，再调用 `subagent` 的 `agent_type: "plugin:agent"` 应用。角色指令注入子任务，工具范围与父任务已有工具取交集，并应用禁用列表；Claude 的 Read、Write、Edit、Bash 等名称映射到 CardBush 工具。Claude 模型别名不自动切换模型，使用 CardBush 子 Agent 配置。带参数的工具规则、Agent 私有 MCP、隔离、记忆及权限覆盖等专有设置尚不支持。
- **Hooks**：读取 `hooks/hooks.json` 或清单中的内联/文件声明。支持 `command` 类型的 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、Stop、SubagentStart、SubagentStop，支持 matcher、timeout 和 once。启用后在相应任务阶段自动运行，工作目录为任务目录；通过 stdin 接收事件 JSON，通过 stdout JSON、stderr 和退出码反馈。支持拦截、补充上下文、工具参数更新及要求确认；参数更新后仍经过原有工具校验和权限检查，Hook 的 allow 不绕过宿主权限。执行记录、错误、超时和取消会出现在任务操作记录中。
- **Commands**：原生读取默认 `commands/` 或清单声明的 Markdown 文件，保留原始文档，不生成 Skill。组件类型为 `command`；输入框 `/插件名:命令名` 菜单显示说明与 `argument-hint`，提交后由宿主调用。模型可通过 `list_plugin_commands` 发现命令、`run_plugin_command` 调用允许自动调用的命令。支持 `$ARGUMENTS`、零起始的 `$ARGUMENTS[n]` / `$n` 和 `arguments` 声明的命名参数；引号内的参数视为一个值。`disable-model-invocation`、`user-invocable` 在宿主校验，停用插件后入口与调用同时失效。

命令文档中的 `!` 加反引号片段和 ` ```! ` 块由宿主在调用时执行，输出注入命令正文，不在安装时执行。支持 Bash（Windows 使用 Git Bash）和显式 PowerShell；参数通过 shell 变量传入，避免作为额外脚本展开。动态步骤先通过原有终端授权，硬拒绝、超时、退出失败和停止取消都保留运行事实。`disallowed-tools` 的普通工具名规则在本轮宿主执行，命令与同批其他工具按顺序处理，下一轮恢复原有范围。`allowed-tools` 原始预授权声明保留并展示，不能覆盖 CardBush 权限设置。动态上下文属于整条命令的运行记录，当前不单独投射成 Bash Hook 事件。每次调用最多 20 个动态步骤，每步 30 秒、输出限 256 KiB。命令的 `context: fork`、私有 Hooks 和带参数的禁用规则仍会提示不兼容；模型沿用当前会话配置。

命令型 Hook 默认使用 Bash（Windows 需要 Git Bash），也支持显式 `shell: "powershell"` / `"cmd"`，或 `command` 加 `args` 数组的直接进程调用。提供 `CLAUDE_PLUGIN_ROOT`、`CODEX_PLUGIN_ROOT`、`CARDBUSH_PLUGIN_ROOT`、`CLAUDE_PROJECT_DIR` 和 `CLAUDE_PLUGIN_DATA`；插件依赖的 Python 等解释器仍需本机安装。默认超时 30 秒，可配置到 600 秒；输入限 2 MiB，输出限 256 KiB。停止任务会终止 Hook 进程树；Stop/SubagentStop 最多触发两次补充处理，避免无限阻止任务结束。

这是 Claude 格式的部分运行适配，不能声称完整兼容 Claude 执行语义。当前不提供 Claude transcript 文件、`CLAUDE_ENV_FILE`，事件 JSON 中 `permission_mode` 使用 CardBush 权限模式。prompt/agent/http/async Hooks、额外 Hook 事件、LSP、Channels、Monitors、用户配置及其他宿主专有组件仍会提示不兼容。检测到不兼容组件、缺失必需环境变量、额外认证要求、无可加载能力或同名来源冲突时，显示具体原因并阻止安装。

市场预览先固定 Git 提交并下载到 `userData/plugin-marketplaces/previews`，与已安装目录分离。安装使用预览 token 对应的同一份文件，不重新追踪分支；源信息和提交记录在包内 `.cardbush-marketplace.json`。更新只能替换同一市场来源的包。移除市场来源保留已安装插件。下载或校验不运行包内脚本；实际启用后的 MCP 按现有 Runtime 规则启动，Agents 和 Hooks 在后续任务加载。市场缓存失败回退会明确标注。GitHub 临时连接重置会有限重试，raw 内容读取失败时可回退到 Contents API；网络错误提供代理设置入口。

市场桥接接口依次为 `pluginMarketSources` / `addPluginMarket` / `addLocalPluginMarket`、`pluginMarketCatalog`、`previewMarketPlugin`、`installMarketPlugin`。这些是受宿主限制的界面 IPC，不是已有的模型工具。文件安装后，界面重新读取并保存目标插件的安装/启用状态；启用失败可以重试，不重复安装。保留全局插件服务开关和其他插件状态；全局关闭时需用户从设置启用服务。界面“已安装”不表示 MCP 已连接，应读取实际连接状态。

状态读取是 Product Host 命令 `{ kind: 'apps.get' }`。更新命令形状如下，`current` 必须来自刚读取的当前配置，`targetId` 必须匹配准确插件：

```javascript
const command = {
  kind: 'apps.update',
  config: {
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

这是卸载状态更新的内部契约示例，不是 shell 命令或现成模型工具。安装/启用改为目标的 `true/true`；单独停用只改变 `enabled`。前端已有 `fetchCardbushAppsConfiguration` / `saveCardbushAppsConfiguration`。Skill、插件清单和 MCP 配置目录的变更会通知界面并触发刷新；缺失目录新建后也会自动发现。Skill 搜索每次读取当前文件，保留用户禁用名单。MCP 空闲时应用，有活动 Turn 时自动排队，任务结束后应用，无需手动再次发送消息或重启整个 Runtime。未变更服务保留连接，变更服务重连；加载失败保留上次可用目录并报告失败。当前模型请求已发送的工具列表不会在请求中途被改写，新增 MCP 能力供后续任务使用。

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
```

用户实际安装完成后，重新读取 CardBush 目录/状态；检查启用的插件 skill 根目录或实际 MCP 工具是否出现。卸载后验证该插件的 skill/工具退出发现；独立添加到 MCP 设置中的同名服务不自动视为插件附属资源。
