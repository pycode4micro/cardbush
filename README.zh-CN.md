# CardBush 桌面端

[English](README.md)

CardBush 是一款 Electron 桌面 Agent 应用，生产 Agent Runtime 已使用
TypeScript 内聚到应用中。普通对话、会话、模型调用、工具、权限、Goal、
Plan、Subagent、Team 与持久化均通过 Electron 类型化 IPC 在 CardBush 内部
运行，不再要求 BushServer HTTP 进程或 localhost 端口。

## 当前状态

当前开发基线为 `1.0.0-dev`。产品功能仍在一体化验证中，安装程序和版本
冻结时点尚未确定。

## 开发启动

要求 Windows、Node.js `>=22.12.0` 与 npm `>=10`。

```powershell
npm install
npm run dev
```

构建并打开桌面应用：

```powershell
npm run gui
```

Electron binary 缺失时运行：

```powershell
npm run fix:electron
```

## Runtime 架构

- `@cardbush/bush-runtime`：与 Provider 无关的 Agent Loop；
- `@cardbush/bush-protocol`：命令、事件与 IPC 类型契约；
- `@cardbush/bush-provider-openai`：OpenAI 兼容 Provider 传输；
- Electron Utility Process：Runtime 执行与持久化；
- Electron 主进程：原生桌面能力和 Product Host 配置；
- React：消费类型化 Runtime 事件，不从模型正文猜测终态。

独立 BushServer 仓库只作为参考实现和迁移对照，不是 CardBush 的生产依赖。

## 可选 MCP 扩展

外部扩展通过统一 MCP 配置安装。工具必须提供完整的
`cardbush/action_manifest`，从而复用 Runtime 的权限、回执和执行事实链路。

CardBush 随应用提供一个独立 stdio MCP 服务 `cardbush_apps`，内置的
`computer_use` 等插件由该服务承载；它们不是 Runtime Built-in Tool，也不通过
私有 Product Host 桥接执行。边界说明见
[`docs/host/CARDBUSH_APPS_MCP.md`](docs/host/CARDBUSH_APPS_MCP.md)。

Bot 产品保持完全独立。CardBush 不管理 Bot 账号、凭据、登录、配置、进程、
日志或管理界面。Bot 项目可以自行提供管理 HTML，并通过一个 MCP `deliver`
工具接入；CardBush 不识别固定服务 ID，也不存储 Bot 私密配置。完整边界见
[`docs/host/CARDBUSH_APP_HOST.md`](docs/host/CARDBUSH_APP_HOST.md)。

## 验证

```powershell
npm run test:all
```

快速检查：

```powershell
npm run typecheck
npm run build
npm run test:runtime
```

## 数据与安全

Runtime 状态、日志和大型缓存位于 Electron 本地 `userData`。小型用户设置由
桌面产品层管理。Provider 凭据仅通过类型化 binding 命令进入 Utility Process，
不会写入 Model Request、事件日志、检查点或渲染层数据。

渲染进程启用 context isolation，且不开放 Node.js integration。提交问题时
不要附带凭据、`.env`、未脱敏日志或用户会话数据。

## 目录结构

```text
electron/   Electron 主进程、Utility Runtime Host 与原生能力
packages/   Runtime、协议、Provider、MCP Client 与 Product Host
src/        React UI 与类型化 Runtime Client 接入
scripts/    开发辅助与契约/发布检查
docs/       Runtime、产品与扩展契约
```
