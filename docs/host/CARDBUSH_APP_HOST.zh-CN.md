# 独立 Bot MCP 边界

[English](CARDBUSH_APP_HOST.md) · [简体中文](CARDBUSH_APP_HOST.zh-CN.md)

CardBush 不维护 Bot 产品、账号库、登录、渠道适配、管理 UI、进程监督或渠道配置。Bot 是用户可选安装的独立 MCP 项目，自行负责凭据和密钥存储、登录/扫码/刷新/删除、渠道配置与生命周期、管理页面、轮询/webhook/投递语义、日志、更新及恢复。

这些接口不通过 CardBush 设置或 Product Host IPC 代理。CardBush 不应特殊处理某个 Bot server ID 或读取其私有配置。

## MCP 接口

建议 Bot MCP 提供一个名为 `deliver` 的模型可见工具，通过 Bot 服务发送文字和已生成的本地文件。输入 schema 与标准 MCP annotations 由 Bot 声明；CardBush 沿用普通外部工具的发现、权限及调用流程，保留原生结果。

工具不由 CardBush 自行注册：没有该 MCP 就没有 `deliver`，多插件由普通 MCP 命名空间区分。示例：

```json
{
  "text": "任务已完成",
  "deliverables": [{"path": "D:/workspace/report.pdf"}],
  "conversation_ref": "opaque-bot-owned-reference"
}
```

`conversation_ref` 对 CardBush 是不透明引用。Bot 验证并映射账号、渠道及接收人，CardBush 不保存渠道 token，也不从会话 ID 推导收件人。

## CardBush 负责的边界

CardBush 负责 TypeScript Runtime、模型配置、会话、权限及通用 MCP 快照加载。桌面 `computer_use` 来自单独启动的内置 `cardbush_apps` MCP，不是 Runtime 默认工具或 Product Host 适配器。旧内置微信/飞书/Telegram/Discord、BotSupervisor、Bot 设置、分享链接交接及 `transport_deliver` 已移除。

无需额外 localhost HTTP 桥；外部 MCP 可使用 stdio 或通用 MCP 客户端支持的其他传输。
