# CardBush companion host

`cardbush_app` is the desktop-owned companion process for CardBush. It owns
host-specific capabilities and Bot adapter lifecycles; BushServer remains the
generic agent runtime.

## Ownership boundary

CardBush owns:

- starting and stopping `cardbush_app`;
- Bot configuration, secrets, login state, logs, and adapter processes;
- the `computer_use` and `transport_deliver` MCP tools;
- registering and unregistering the companion MCP server with BushServer.

BushServer owns:

- sessions, turns, LLM loops, tool-result truth, permissions, and receipts;
- generic MCP discovery, schema activation, context projection, and invocation;
- the public chat/session APIs used by Bot adapters.

BushServer does not expose Bot-management routes and does not import any Bot or
desktop implementation.

## Processes and endpoints

Electron starts one loopback-only companion with a random bearer token. The
companion exposes:

- `GET /readyz` (no secrets, no authentication);
- streamable HTTP MCP at `/mcp`;
- private host routes under `/host/v1/bots`.

The renderer never receives the bearer token or companion port. It calls the
private host API through the allow-listed `cardbush-app:request` Electron IPC
handler. Only `/host/v1/*` paths are accepted.

Bot host routes:

```text
GET    /host/v1/bots
GET    /host/v1/bots/{platform}/config
PUT    /host/v1/bots/{platform}/config
GET    /host/v1/bots/{platform}/status
POST   /host/v1/bots/{platform}/service/{start|stop|restart}
GET    /host/v1/bots/{platform}/service/logs
POST   /host/v1/bots/weixin/login/start
GET    /host/v1/bots/weixin/login/{login_id}/status
DELETE /host/v1/bots/weixin/accounts/{account_id}
```

Errors use the host envelope:

```json
{
  "error": {
    "code": "bot_not_configured",
    "message": "Missing required field(s): app_id, app_secret"
  }
}
```

Secrets are stored in the CardBush user-data directory, are masked in API
responses, and are redacted from host-managed logs.

## MCP registration

After `/readyz`, Electron registers `cardbush_app` at BushServer with
`PUT /v1/mcp/servers/cardbush_app`. If BushServer is not running yet,
registration retries every two seconds without blocking Bot management. A clean
CardBush shutdown unregisters the MCP server before stopping the companion.

Only the following runtime context may cross the MCP boundary:

```text
session_id
turn_id
tool_call_id
transport_channel
permission_grants
filesystem_roots
```

No provider key, prompt, arbitrary request metadata, or host bearer token is
projected into tool arguments.

`transport_deliver` returns `bushserver.tool_result.v1`. A successful call proves
that files were validated against MCP Roots and staged. It deliberately sets
`send_confirmed=false`; only the transport adapter's later authoritative receipt
may prove remote delivery.

## Bot runtime configuration

The companion passes Bot subprocess settings through `CARDBUSH_BOT_*` variables
and `CARDBUSH_APP_DATA_DIR`. The removed `BUSH_OTHER_GUIS_*` variables are not
accepted.

Bot adapters connect to the configured loopback BushServer public API. They do
not start BushServer and do not inherit the companion's private host API token.

## Lifecycle guarantees

- start and stop are idempotent;
- only enabled and configured adapters can start;
- enabled adapters auto-start after the companion lifespan begins;
- Weixin login workers and Bot adapter process trees stop before the companion
  exits;
- managed Weixin workers monitor the CardBush host PID and exit when it dies;
- Electron waits for graceful shutdown, then applies a bounded process-tree kill
  only to the known companion PID;
- an unexpected companion exit clears the Electron service state so a later host
  request can start a fresh instance.
