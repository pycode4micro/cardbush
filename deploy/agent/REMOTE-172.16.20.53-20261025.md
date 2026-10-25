# 172.16.20.53 Agent 更新记录

2026-10-25 已将 `Agent-111` 更新并重启至完整发布包 `20261025-unified-tools`。源码来自本地工作区，基于 `9253d0a5a6070f7418b121b94418a53d0a109d96`，包含本次尚未提交的修改；不是该提交的纯净构建。

- 主机：Windows x64，Node.js `v24.22.0`。
- 服务：`CardBushAgentA`，沿用 NSSM 和原 `cardbush-agent` 服务账号。
- Agent ID：`agent-61ed85d4-76a9-4bd9-8c68-44aa2dc22f6e`。
- 发布目录：`C:\cardbush\releases\1.0.11-20261025-unified-tools`。
- 当前入口：`C:\cardbush\current`，已指向新发布目录。
- 数据目录：`C:\cardbush\data\agent-a`。
- 服务地址：`http://127.0.0.1:4780`，继续通过现有 SSH 连接使用。
- 令牌文件：`C:\cardbush\data\agent-a\access-token`，内容未变，不记录令牌。

## 更新内容

完整更新 Agent 运行时代码、内置资源和 Windows 原生组件，在新目录执行 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund --no-progress`。用户安装的插件、技能和配置保持原样。

实际服务工具目录已确认：

- `call_tool` 统一执行原生及 MCP 业务工具。
- `get_tool_schema` 统一加载定义，支持 `name` 和批量 `names`。
- `mcp_search` 只发现工具名称，不再带 `action=load`。
- `mcp_call` 不再注册。

发布包同时包含当前已验证的图片快照读取、CLI 生命周期及 Browser Use 修改。没有调用真实模型或重新执行用户的业务工具。

## 验证

- 本地完整 `build:agent` 成功；发布、统一调用及相关回归 76 项通过。
- 远程安装依赖后，隔离数据目录启动验证通过，2,078 个发布文件的 SHA-256 与上传清单一致。
- Windows 原生进程保护、内置资源、真实 HTTP 接入通过。
- 正确令牌可用；无令牌、错误令牌和携带 `Origin` 的请求均拒绝。
- 正式服务 Agent ID 不变，用户指定的 `session-3fc2a87e-67a3-4edd-8464-6c34457988d8` 可读取。
- SSE/NDJSON 事件流握手通过；未重新提交原任务。
- 29 个配置、凭据、用户技能/插件清单及会话文件的校验值无变化；任务记录仍为 5 条，上线验收时没有运行或排队任务。
- Browser Use、百应、千川及其他 9 个 MCP 服务为 `ready`。
- Computer Use 的 `cardbush_apps` 为 `unavailable`，桌面助手探测为 `probe_failed`；这是更新前已存在的状态。本次没有配置或启动新的桌面会话。

## 备份与运维

切换前确认空闲并停止服务，备份约 11.56 GiB 数据，保留文件 ACL。外部目录连接未被遍历，原数据目录及连接仍在原处。

- 数据备份：`C:\cardbush\deploy\update-20261025-unified-tools\backup\data`。
- 旧版本：`C:\cardbush\releases\1.0.11-20261020`。
- 旧版本入口备份：`C:\cardbush\current-before-20261025-unified-tools`。
- 发布、安装和验收记录：`C:\cardbush\deploy\update-20261025-unified-tools`。
- 服务日志：`C:\cardbush\logs\agent-a.out.log` 和 `agent-a.err.log`。
- 管理命令：`Get-Service CardBushAgentA`、`Stop-Service CardBushAgentA`、`Start-Service CardBushAgentA`。

需要回滚时，先确认没有活跃任务，停止该服务，再将 `current` 入口切回已保留的旧版本。不要把历史数据备份直接覆盖到仍在使用的数据目录；备份后的新任务和状态应先单独保存。
