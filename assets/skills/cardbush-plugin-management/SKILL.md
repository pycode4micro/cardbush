---
name: cardbush-plugin-management
description: 创建、安装、更新、启停或卸载由 CardBush 加载的插件包时使用，遵循 CardBush 的清单和 Product Host 生命周期。单独添加第三方 MCP 连接使用 cardbush-mcp-management；其他软件自身的插件按该软件的流程管理。
license: Proprietary
---

# CardBush 插件管理

按用户要求处理 CardBush 插件。先读取 [CardBush 插件契约](references/plugin-contract.md)，按当前任务选择创建、安装或卸载流程。

## 宿主与边界

- 按安装对象选择流程。同一任务可以同时包含外部软件的插件、MCP 服务程序和 CardBush 的连接配置；本 skill 只覆盖其中的 CardBush 插件包部分。
- 将第三方 MCP 接入 CardBush 时，搜索并读取 `cardbush-mcp-management`。可直接注册 MCP 连接，无需额外创建 CardBush 插件包。外部软件的插件步骤不适用本 skill，不影响继续完成 CardBush 端接入。
- `.codex-plugin/plugin.json` 是 CardBush 当前采用的兼容清单格式，不代表插件应安装到 Codex。插件目录、配置、启停和卸载均由 CardBush 管理。
- 不为本任务调用 Codex 插件安装/卸载工具、运行 `codex plugin`，或改写 `.codex` 的插件缓存和市场配置。用户明确要求其他宿主时，该任务不适用本 skill。
- 插件拥有自己的 skill、MCP 或 app 组件及原生返回结果。不要为安装插件新增统一事实协议或改造 Runtime Built-in Tools。
- 先区分用户要创建插件包、安装已有插件、停用还是卸载。已有明确请求即可按其范围执行，不增加重复确认。

## 创建

1. 在用户指定的工作目录创建插件包；使用契约中的最小清单，目录名与 `name` 一致。图标和声明的组件路径必须实际存在且位于包内。
2. 根据需要添加 `skills`、`mcpServers`、`apps`，不凭空加入 hooks、远程市场或其他宿主特有能力。只有 skill 的插件不需要 MCP。
3. 用 CardBush 实际清单加载器校验组件及路径。创建完成不等于已经安装，清单中出现 MCP 名称也不等于工具已连接。

## 安装与更新

1. 从 CardBush 插件目录/配置确认准确 ID、来源、当前版本和状态。个人包可能覆盖同 ID 的内置包；更新前检查现有包内容，保留用户修改。
2. 已在公共目录中的插件，通过 CardBush 管理界面安装并启用。新的本地包通过“添加 → 从本地安装插件”选择完整包目录，使用宿主的本地安装流程。
3. 复制包后重新读取安装状态。此前卸载过的同 ID 插件可能仍为 `installed=false`，不能仅凭复制成功宣布重新启用。
4. 读取安装后的清单、安装/启用状态和实际 skill/MCP 发现结果；宿主自动发现目录变更。遇到正在运行的 Turn，等待排队的 MCP 配置在任务结束后自动应用，再验证实际发现结果，不中断用户当前工作来强制刷新。

## 停用与卸载

- 停用：保持 `installed=true`，设置 `enabled=false`。
- 卸载：通过 CardBush Product Host 的配置更新将目标设为 `installed=false, enabled=false`，保留其他插件和全局服务设置。使用当前可调用的宿主入口，命令形状见契约；不要把内部命令名当成已经存在的模型工具。
- 普通卸载保留包文件和配置，以便重新安装。用户另外要求删除个人插件文件时，确认准确的个人包路径和同 ID 覆盖关系后再清理；不要删除应用随包资源。
- 当前版本若未暴露可调用的卸载入口，如实说明缺口；在代码开发任务中复用现有 Product Host 实现补接入口。不要伪造成功、将停用冒充卸载，或绕过宿主直接热改配置文件。

## 完成标准

报告准确插件 ID、包位置、安装/启用状态以及已验证的组件。将“包已生成”“包已安装”“组件已可用”分别按证据说明。仅写好 skill 不会自动赋予模型新的插件管理工具。
