# CardBush Product Host

CardBush owns product integrations in the Electron main process. The Agent Runtime
runs in an Electron Utility Process and communicates with the Product Host through
the versioned typed IPC protocols in `@cardbush/bush-protocol`.

The Product Host owns:

- Bot configuration and lifecycle for Weixin, Feishu, Telegram and Discord;
- Bot conversation routing into the shared Agent Runtime;
- inbound media materialization and outbound file delivery;
- native Computer Use execution;
- the current default model snapshot used by Bot conversations.

The Runtime owns Tool registration, admission, permissions, Execution Facts and
Turn lifecycle. The Product Host executes only an already admitted typed request
and returns structured results and Artifacts. It does not infer completion from
text, select receipts, or classify tasks.

Built-in product capabilities never connect back to CardBush over HTTP or MCP.
External MCP servers remain independently configurable and are synchronized into
the Runtime Tool Registry through their declared manifests.

## IPC boundaries

- Renderer to Product Host: `cardbush.product_host_ipc.v1` over
  `cardbush-product-host:command`.
- Runtime Utility Process to Electron Host: `host_tool_request` and
  `host_tool_response` in `bush.runtime_ipc.v1`.
- Runtime events to Renderer: `bush.runtime_event.v1`.

Secrets are accepted only by typed configuration commands and are not projected
back in responses. Bot state is stored under Electron `userData/product-host` with
serialized writes and recoverable file replacement on Windows.

## Removed boundary

The former Python `cardbush_app` child process, private `/host/v1/*` routes, local
HTTP token, and built-in `cardbush_app` MCP self-registration are removed. Python
BushServer remains a separately frozen reference implementation; it is not a
CardBush production dependency.
