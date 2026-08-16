# CardBush 桌面端

[English](README.md)

CardBush Desktop 是 BushServer 的 Electron 客户端。桌面端负责界面、项目、会话、本地桌面能力和后端能力发现；BushServer 负责模型调用、Agent 编排、Skills、Tools、权限、持久化和任务委派。

## 发布状态

当前前端基线版本为 `1.0.0-rc.1`。

- 产品功能已冻结，进入 RC 一体化打包阶段。
- 源码构建和前端契约已经可以用于内部验证。
- Windows 一体化安装程序尚未完成；剩余交付工作是 Electron 托管 BushServer 生命周期、运行时版本握手和安装程序打包。
- RC 阶段只接受发布工程、兼容性、安全、数据保护和阻断性缺陷修改。

## 当前能力

- SSE 对话流、思考与工具输出、停止、重新生成、消息编辑和回合引导。
- 项目会话、历史记录、运行状态和工作区修改审查。
- 附件、本地文件引用、图片输入、权限模式、终端运行时、Skills、Tools 和模型选择。
- 文本、图片、Word、Excel 和 PowerPoint 文件的本地只读预览。
- 外观、语言、代理、模型、MCP、Bot、运行诊断和本地维护设置。
- Team 工作流和后端托管子任务状态界面。

## 开发要求

- Windows 开发环境
- Node.js `>=22.12.0`
- npm `>=10`
- 兼容版本的 BushServer 源码或服务

未来安装程序的最终用户不需要安装 Node.js 或 Python；这些要求只适用于一体化打包完成前的源码开发。

## 开发启动

安装依赖，并启动 Vite、TypeScript 和 Electron 开发进程：

```powershell
npm install
npm run dev
```

如果 Electron 安装后缺少 binary 或 `path.txt`：

```powershell
npm run fix:electron
```

构建并从源码打开桌面端：

```powershell
npm run gui
```

## BushServer 连接

开发构建默认连接 `http://127.0.0.1:51717`，可以在构建前覆盖：

```powershell
$env:VITE_BACKEND_BASE_URL='http://127.0.0.1:51717'
```

`51717` 只作为开发默认端口。正式 RC 安装包将由 Electron 主进程选择可用的 localhost 端口，启动内置 BushServer，并向渲染进程注入运行时地址。

前端以 `GET /v1/capabilities` 作为可选能力的唯一来源。一体化打包还将使用 `GET /readyz` 完成服务版本和兼容性握手。

## 验证

运行完整前端发布门禁：

```powershell
npm run test:all
```

该命令会依次运行全部 `test:*` 契约测试（不包含自身）、两套 TypeScript 检查、生产构建和最终生产包清理检查。

快速开发检查：

```powershell
npm run typecheck
npm run build
npm run test:release-cleanup
```

## 运行数据和诊断

一体化安装程序将使用以下 Windows 目录：

```text
%LOCALAPPDATA%\CardBush\
├─ server-data\
├─ logs\
└─ crash\

%APPDATA%\CardBush\
└─ config\
```

大型运行数据、日志、缓存和崩溃信息放在 `%LOCALAPPDATA%`；只有需要漫游的小型用户配置放在 `%APPDATA%`。

生产环境默认关闭滚动诊断。只有临时诊断时，才通过 local storage 将 `cardbush_scroll_debug` 显式设为 `true`。

## 前后端边界

- 前端不选择或注册主 Agent Profile。
- BushServer 决定任务委派并拥有 Agent 运行时。
- BushServer 加载和管理 MCP；前端只负责编辑配置与展示状态。
- 项目模式将工作区路径传给 BushServer，前端不自行拼装项目上下文。
- 本地资源路径通过请求 metadata 传递，并继续受后端权限边界约束。
- 功能是否显示以 `/v1/capabilities` 为准，不根据 Provider 名称或接口 404 猜测。

当前前端使用的主要接口：

- `GET /healthz`
- `GET /v1/capabilities`
- `POST /v1/chat/stream`
- `GET /v1/sessions`
- `GET /v1/sessions/{session_id}`
- `POST /v1/turns/{turn_id}/stop`
- `GET /v1/skills`
- `GET /v1/model-configs`
- `GET /v1/team-flows/{session_id}`
- `GET /v1/team-flows/{session_id}/graph`
- `POST /v1/team-flows/{flow_id}/actions`
- `GET /v1/subagents/capabilities`
- `GET /v1/subagents/runtime`
- `POST /v1/sessions/{session_id}/subagents/dispatch`
- `GET /v1/mcp/servers`

## 常见问题

### 桌面端无法连接 BushServer

1. 确认 BushServer 已经运行。
2. 打开设置中的连接诊断。
3. 检查开发地址的 `/healthz` 和 `/v1/capabilities`。
4. 确认代理绕过列表包含 `127.0.0.1`、`localhost` 和 `::1`。
5. 重启前先检查桌面端与 BushServer 日志。

### 某项功能没有显示

检查 `/v1/capabilities`。连接的后端未声明某项可选能力时，前端会主动隐藏或禁用对应功能。

### Electron 安装后无法启动

源码开发环境运行 `npm run fix:electron`。安装包问题需要同时提供应用版本、后端版本、Windows 版本以及 `%LOCALAPPDATA%\CardBush\logs` 中的日志。

## 目录结构

```text
electron/   Electron 主进程、preload 桥接和本地桌面能力
src/        React 界面、功能模块和 BushServer API 客户端
scripts/    开发辅助脚本和发布契约测试
public/     运行时静态资源
docs/       前后端契约与实现检查清单
```

## 安全说明

- Electron 渲染进程启用 context isolation 和 sandbox，并关闭 Node.js integration。
- 安装版 BushServer 必须只监听 localhost，并要求每次安装生成的本地请求密钥保护 API 与 SSE。
- 凭据和本地请求密钥不能写入日志，也不能通过进程命令行参数传递。
- 提交问题时不要附带 `.env`、凭据、未经清理的完整日志或用户会话数据库。
