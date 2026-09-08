---
name: cardbush-mcp-management
description: 在 CardBush 中添加、配置、连接、检查、启停或移除第三方 MCP 服务时使用，包括让 agent 自行安装 MCP 并接入当前宿主。区分服务程序、目标软件自身的插件与 CardBush 的 MCP 连接；不用于其他客户端的 MCP 配置。
license: Proprietary
---

# CardBush MCP 接入

CardBush 已有原生 MCP 客户端。通过宿主提供的管理工具注册服务，使用 Runtime 实际发现的工具名调用。

## 安装对象

根据任务涉及的组件采用对应流程：

| 对象 | 管理方式 |
|---|---|
| Blender、浏览器等软件自身的插件或扩展 | 该软件的安装、启用接口和文档 |
| 本地 MCP 服务程序及依赖 | 该服务的包管理器、安装或启动说明 |
| CardBush 的 MCP 连接 | 下述 CardBush 管理工具 |
| 需要复用或分发的 CardBush 插件包 | `cardbush-plugin-management` |

一个请求可能需要完成多行。第三方软件的名字说明操作对象，不代表 MCP 连接应该配置到那个软件里。单独注册 MCP 无需创建 CardBush 插件包。

## 宿主管理入口

- `mcp__cardbush_management__list_mcp_servers`：读取已保存的连接标识、Runtime 应用状态、连接健康及发现的工具名。凭据值不会返回。
- `mcp__cardbush_management__configure_mcp_server`：新增或修改指定 `id` 的连接；只修改传入的字段。`env`、`headers` 按键合并，键值设为 `null` 表示移除该键。`enabled: false` 停用，`true` 启用。
- `mcp__cardbush_management__remove_mcp_server`：移除指定连接，保留服务程序和外部软件插件文件。

新增 stdio 示例，路径替换为实际已安装的服务入口：

```json
{
  "id": "example_service",
  "name": "Example MCP",
  "transport": "stdio",
  "command": "C:\\absolute\\path\\server.exe",
  "args": [],
  "enabled": true
}
```

HTTP 服务使用 `transport: "streamable_http"` 和实际 `url`；需要旧版 SSE 时使用 `"sse"`。启动所需的 `cwd`、`env` 或 `headers` 按服务说明提供。CardBush 及插件拥有的保留连接由各自管理流程处理。

已有明确安装请求时按其范围执行。工具缺席时，如实说明缺少的是当前可调用的管理入口，不能据此断言 CardBush 不支持 MCP；内部 `mcp.update` 命令或配置文件路径不等于已提供的模型工具。使用当前版本实际可用的宿主界面或入口。

## 核对实际状态

管理结果分别返回配置与运行状态：

- `saved` 和 `configurationRevision`：配置已保存。
- `runtime.applicationState: "pending"`：有活动任务，配置会在活动任务结束后自动应用；在同一活动任务中继续等待不能使其提前生效。
- `"applied"`：这一批配置已应用；再检查目标服务的 `health` 和 `tools`。
- `"failed"`、`applicationError` 或 `runtimeError`：按实际错误处理；旧连接仍可能存在，不代表新配置已成功。

以目标服务实际发现的工具名做适合该服务的验证。独立客户端测试可以验证服务程序，但不能证明 CardBush 已接入。若本轮返回待生效，报告已保存、待任务结束后接入；后续读取状态并调用工具时再确认可用。外部软件需要保持运行或单独启用桥接时，说明这一实际依赖。
