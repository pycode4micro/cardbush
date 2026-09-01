# Independent Bot MCP boundary

CardBush does not own a Bot product, account store, login flow, channel adapter,
management UI, process supervisor, or channel-specific configuration. A Bot is an
independent project that users may install as an optional MCP server.

The Bot project owns all of the following:

- account credentials and local secret storage;
- login, QR confirmation, token refresh and account removal;
- channel configuration and service lifecycle;
- its own management HTML or desktop UI;
- inbound polling/webhooks and channel-specific delivery semantics;
- logs, upgrades and recovery.

None of those surfaces are proxied through CardBush settings or Product Host IPC.
CardBush must not special-case a Bot MCP server ID or inspect its private config.

## MCP surface

The recommended Bot MCP surface contains one model-visible tool named `deliver`.
It sends text and/or already-created local artifacts through the Bot service. The
Bot server declares its input schema and standard MCP annotations. CardBush
applies the same discovery, permission and invocation lifecycle used for every
other external MCP tool while preserving its native MCP result unchanged.

The tool name is intentionally not registered by CardBush itself. If the Bot MCP
is absent, `deliver` is absent. If multiple independent delivery plugins are
installed, normal MCP namespacing keeps them distinct.

An example input shape is:

```json
{
  "text": "任务已完成",
  "deliverables": [
    { "path": "D:/workspace/report.pdf" }
  ],
  "conversation_ref": "opaque-bot-owned-reference"
}
```

`conversation_ref` is opaque to CardBush. The Bot project validates it and owns
the mapping to an account, channel and recipient. CardBush never stores channel
tokens or derives a destination from a CardBush session ID.

## CardBush-owned boundary

CardBush still owns its TypeScript Agent Runtime, model configuration, sessions,
permissions, and generic MCP snapshot loading. Desktop `computer_use` is provided
by the separately launched, bundled `cardbush_apps` MCP server; it is not a Runtime
Built-in Tool or a Product Host adapter. The former built-in
Weixin/Feishu/Telegram/Discord adapters, BotSupervisor, Bot settings page,
share-link handoff, and `transport_deliver` Product Host tool are intentionally
removed.

No localhost HTTP bridge is required. External MCP transport may be stdio or any
other transport supported by the generic MCP client configuration.
