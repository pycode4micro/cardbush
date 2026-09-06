# 当前 CardBush 插件契约

代码依据：`electron/productPlugins.ts`、`electron/main.ts`、`packages/cardbush-product-host/src/appsConfigStore.ts`、`src/backend/api.ts`。维护本 skill 时检查这些实现；安装包环境没有源码时，以宿主实际返回和已提供入口为准。

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
- `skills` 当前为一个相对目录字符串，目录下每个子目录是一个 skill 包。
- `mcpServers` 可为内联对象或指向 JSON 文件的相对路径；`apps` 为指向 app 配置文件的相对路径。只添加当前任务需要的组件，并检查对应文件及实际加载链。
- 已安装且启用的普通插件 MCP 会由 Runtime 自动加载，支持 stdio、HTTP 和 SSE；服务 ID 为 `plugin_<插件ID>_<服务ID>`（插件 ID 中的点替换为下划线），工具名以宿主实际返回为准。stdio 默认 cwd 为插件根目录，command/args/env/cwd 中可用 `${CARDBUSH_PLUGIN_ROOT}`。普通插件工具默认需要权限检查。Computer Use 和 Chrome 保留专用启动链。app 组件的目录展示仍不等于通用执行接入，必须验证实际入口。

## CardBush 自己的目录

- 开发环境公共插件：应用根目录 `assets/plugins`，由其中的 `marketplace.json` 编目。仅在开发内置公共插件时修改该市场文件。
- 个人插件：`app.getPath('userData')/plugins/<id>`；从宿主确定实际 userData，不将某台电脑的用户名、`APPDATA` 推测值或 Codex 目录当成固定路径。
- 插件状态：`userData/product-host/config/apps.json`，由 Product Host 管理。
- 此管理 skill 位于 `assets/skills/cardbush-plugin-management`，使用 CardBush 内置 skill 发现与打包流程。它本身不需要另建插件清单。

## 现有安装与状态接口

本地安装界面调用 `window.cardbushDesktop.installLocalPlugin()`，通过 `plugins:install-local` IPC 打开目录选择器，再由 `installProductPlugin(sourcePath, userPluginRoot)` 校验并复制。它不是接受任意路径参数的公开模型工具；不能凭空向它传入 sourcePath。

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
```

用户实际安装完成后，重新读取 CardBush 目录/状态；检查启用的插件 skill 根目录或实际 MCP 工具是否出现。卸载后验证该插件的 skill/工具退出发现；独立添加到 MCP 设置中的同名服务不自动视为插件附属资源。
