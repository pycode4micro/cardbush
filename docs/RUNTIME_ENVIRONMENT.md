# Runtime environment: state, execution and plugin boundaries

`RuntimeEnvironment` is a read-only projection. `AgentExecutionRegistry` owns local execution lifetimes; resource managers own connections, processes and authorization scopes. Tools perform actions against those same owners. An environment read must never connect, select a browser, execute a tool, install a plugin, dispatch a task or grant permission.

## Ownership and delivery

The host injects a read interface into the environment instead of exposing the registry for mutation. Closing observation sources does not close agents. Ordinary parents, children, Shadow, Team, Assistant, Webhook, automation and internal model tasks use the shared execution registry. Real-time voice reports its call lifetime through the private host command `runtime.observe_agent`; voice compaction and spoken summaries register their independent execution IDs. Concurrent text and voice work in one conversation remain separate leases; an old call closing cannot stop a newer call or text turn. Voice host commands are not model tools and are rejected by the public Agent `runtime.command` endpoint.

Remote executions are projected from the existing delegation task ledger, with `hostId`, `transport: remote` and `observationStatus`. Remote read-only policy is unknown (null) until supplied by its owner. They are last-known observations, not proof that a Worker is currently reachable. There is no remote polling or second presence map. Related agents are limited to the current family/project/workspace; at most 64 items are delivered, prioritizing current and active executions. Prompts, transcripts, results and credentials are not agent facts.

| Section | Source and meaning |
| --- | --- |
| `host`, `workspace` | Current Runtime platform and execution directories |
| `agents` | Local execution registry plus related remote delegation records |
| `capabilities` | Request permission mode, interactive requests and read-only state; unknown values are null |
| `sandbox` | The same pure command sandbox evaluator used during execution, including host-required mode and automatic-mode full-access exemption; host network means no additional command sandbox restriction, not proven network reachability |
| `services` | Bot source/connection observations, registered MCP catalog identifiers, current MCP App view status |
| `mcp` | Existing MCP manager health and update state, without schemas, configuration or error bodies |
| `processes` | Current session's local terminals and current turn's background jobs |
| `hostResources` | Existing browser connection status, integrated browser authorized tab identities, session-owned SSH terminals and configured Worker connection state |
| `plugins` | Namespaced state sources contributed by enabled native plugins |

Desktop and CLI/service workers share these projections. A headless service reports no integrated browser, but reports its external connector's actual status. Browser state does not imply permission to call a browser tool, authorize unrelated tabs, or prove network access. Reading a fresh session does not create a binding. Saved Worker configuration is not reported as a live connection. SSH and browser summaries omit command output, page URLs/content, secret tokens and debugging handles.

Product turns append an internal user `runtime_environment` message at normal model boundaries; Assistant uses the same source. The first message is a snapshot, subsequent messages contain changed sections only, and removed sources emit null. After compaction loses the structured baseline, the next read supplies a fresh snapshot. The frozen text-model system prefix remains unchanged. An automatic sandbox with no observed request policy remains unknown instead of assuming a permission mode. Pure maintenance tasks register presence without adding unrelated context. Realtime speech transports attach bounded observations as explicitly marked data through their provider context interface, refresh on connection and natural speech boundaries, and never manufacture a response to refresh state.

Plugin collaboration messages use `conversations.notify` / `agent_peer_context`, not environment state. MCP App user context and durable events retain their own internal user messages. These data channels cannot grant authorization or override the user's task.

## Plugin registration

Trusted native plugins use a single extension factory for tools and status sources:

```ts
export default function create(api: RuntimeExtensionApi): RuntimeExtension {
  api.tools.register(toolUsingConnectionManager);
  const unregister = api.environment.register('connection', ({ request, signal }) => {
    // Pure projection from the same manager used by the tool. Scope to request.sessionId.
    return connectionManager.status(request.sessionId, signal);
  });
  return { id: 'example', features: [], commands: {}, dispose: unregister };
}
```

This appears as `sections.plugins.example.connection`. Installation stages tools and sources together. Invalid/colliding registrations cannot leave orphan state. Enable/disable, replacement and uninstall affect both catalogs. A slow response from an obsolete generation is discarded, including disable/re-enable while a read is pending. Plugins cannot replace core host sections. Registration is for trusted native code, not a sandbox or permission grant; status callbacks must not perform actions, return instructions or expose secrets.

Host adapters use `environmentSources: { name: ({request, signal}) => jsonFacts }`. Each source has a one-second deadline and a 65,536-character JSON limit. Plugin namespaces allow at most 16 sources and a combined 65,536-character snapshot. Requests are cloned before delivery, so a source cannot mutate a turn. Failed, timed-out, nonserializable or oversized sources report unavailable, and request cancellation still propagates. Sources should cooperate with cancellation and return small structured summaries.

## Verification

`runtimeEnvironment.test.mjs` covers shared lifetimes, simultaneous voice/text work, stale completion, related remote identity, plugin admission/revocation, prompt separation, bounds, cancellation, sandbox policy and real concurrent parent/Shadow execution. Browser and voice host tests exercise owner-derived snapshots and lifecycle callbacks without connecting production accounts. Broader Runtime, CLI and App regressions verify existing execution and presentation contracts.
