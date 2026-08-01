# cardbush-electron

CardBush 的 Electron 桌面端。前端负责桌面 UI、项目/会话管理、本地能力入口和后端能力发现；核心运行时、模型调用、Skills、Tools、权限与任务委派由 BushServer 提供。

## 当前能力

- 对话流式渲染：支持 SSE token、工具输出、交互请求、停止、重跑和用户消息编辑后重跑。
- 会话与项目：支持本地生成 session id、新会话默认标题、发送首条消息后自动标题、项目会话、侧边栏运行状态。
- Composer：支持附件、项目上下文、终端环境、权限模式、复杂任务、视觉能力开关、Skills、Git 分支和 Tokens 的渐进式菜单。
- 设置页：支持外观、代理、模型管理、最大上下文窗口、终端环境、Bot 连接、缓存维护和连接诊断。
- 后端托管 Agent 能力：本地子任务是否委派由主 Agent 决定；前端只展示运行状态，不提供本地子代理注册或 Profiles 路由。
- 外部 MCP：支持配置 stdio、SSE、HTTP 类 MCP 服务，由后端加载工具；前端只负责配置、校验、启停和展示状态。
- 本地体验：启动加载页、内置桌面窗口、图片附件缩略图、长文本块换行/复制、工具输出折叠和复制。

## 开发启动

```powershell
npm install
npm run dev
```

如果 Electron 安装后缺少 binary 或 `path.txt`，运行：

```powershell
npm run fix:electron
```

构建后直接打开桌面端：

```powershell
npm run gui
```

## 验证与构建

```powershell
npm run typecheck
npm run build
```

可选的前端专项检查：

```powershell
npm run test:path-metadata
npm run test:markdown
npm run test:tool-visibility
```

## 后端连接

默认连接 BushServer：

```text
http://127.0.0.1:51717
```

可通过环境变量覆盖：

```powershell
$env:VITE_BACKEND_BASE_URL='http://127.0.0.1:51717'
```

应用内也提供代理和认证相关设置。前端应优先读取 `/v1/capabilities` 动态决定功能是否可用，不要硬编码接口存在性。

## 关键后端接口

基础能力：

- `GET /healthz`
- `GET /v1/capabilities`
- `POST /v1/chat/stream`
- `GET /v1/sessions`
- `GET /v1/sessions/{session_id}`
- `POST /v1/turns/{turn_id}/stop`
- `GET /v1/skills`
- `GET /v1/model-configs`

Team Flow 与子任务状态：

- `GET /v1/team-flows/{session_id}`
- `GET /v1/team-flows/{session_id}/graph`
- `POST /v1/team-flows/{session_id}/actions`
- `GET /v1/subagents`

MCP 服务配置：

- `GET /v1/mcp/servers`
- `POST /v1/mcp/servers/validate`
- `PUT /v1/mcp/servers/{server_id}`
- `POST /v1/mcp/servers/{server_id}/enable`
- `POST /v1/mcp/servers/{server_id}/disable`
- `DELETE /v1/mcp/servers/{server_id}`

## 前后端职责边界

- 前端不选择主 Agent Profile，也不通过 Profile 控制路由、工具或执行阶段。
- 前端不注册或切换本地子代理；主 Agent 根据任务和后端策略决定是否委派。
- 远程 Agent 能力通过 MCP 等后端托管协议接入，不与本地子任务配置耦合。
- 前端不启动 MCP 进程、不直接连接 MCP SSE/HTTP 服务；MCP 加载、工具发现、鉴权和生命周期由 BushServer 处理。
- 终端环境以 `/v1/capabilities` 返回的 `terminal_runtime.available/default` 为准；未选择时使用后端默认值。
- 前端不自行生成项目结构上下文；项目模式下把工作区路径传给后端，由 BushServer 生成上下文快照。
- 图片路径会通过 request metadata 传递 allowed paths；视觉模型输入需要显式开启 `standard_image_input_enabled`。
- 会话标题展示不会直接暴露 `local-*`、`weixin:*`、`cardbush-*` 等内部 session id；新会话默认显示为 `新会话`。

## 目录

```text
electron/   Electron main/preload 入口
src/        React 前端和后端 API 封装
scripts/    安装修复、开发端口和本地检查脚本
public/     启动页和运行时静态资源
docs/       项目文档
```

## 说明

本项目从原 `cardbush/electron` 拆出，当前独立路径：

```text
C:\Users\wfang\Desktop\cardbush-electron
```
