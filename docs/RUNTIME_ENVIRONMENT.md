# Runtime environment and Agent lifecycle

The Runtime owns one `RuntimeEnvironment`. `environment.agents` observes all local execution instances: ordinary parents, Assistant, children, Shadow, Team/plugin roles, automation and internal tasks. Installed Agent definitions are capability catalog entries, not live executions.

## Ownership

- `AgentExecutionRegistry` owns execution facts, keyed by session and execution ID: ancestry, workspace, lifecycle, read-only guard and scheduling policy. It stores no prompts, credentials or tool results.
- `RuntimeEnvironment` aggregates facts and registered sources. It creates model observations and serves `runtime.get_environment`. It neither runs agents nor grants permissions.
- `RuntimeConversations` owns mailboxes and bounded coordination wakes. Its compatibility presence list projects the shared registry; it no longer maintains another copy of execution status.
- The turn engine, Assistant, tool permission brokers and other resource owners remain responsible for execution, cancellation and cleanup. Their adapters register/update facts. Resource snapshots are read through source functions, not copied into UI-specific stores.
- AgentChatroom remains an optional plugin. Membership, invitations and peer messages belong to that plugin. Registration is not room membership or consent to communicate.

The registry uses `queued`, `running`, `waiting`, `completed`, `failed` and `stopped`. Terminal updates are lease-specific: a late completion cannot stop a newer execution. Assistant has a distinct observation lease for each pump, without changing existing tool receipt or request IDs. Reset/deletion removes its observations; shutdown clears the registry. At most 256 inactive execution records are retained; active executions are not evicted. Mailboxes and extension context are pruned with retained executions.

Automatic wake eligibility is separate from presence. Children, Shadow, automation, plugin hooks, internal tasks and Assistant are still registered even when independent room notifications cannot start a new turn. Existing parent ownership, tool admission, explicit stop and three-wake coordination limits remain enforced.

## Reading and injecting facts

App and CLI hosts use the same Runtime command:

```json
{"kind":"runtime.get_environment","payload":{"sessionId":"session-id"}}
```

`ProtocolRuntimeClient.getEnvironment(sessionId)` validates the response. Trusted native extensions can call `api.environment.read(sessionId)`. The snapshot protocol is `bush.runtime_environment.v1`, with these sections:

| Section | Contents |
| --- | --- |
| `host` | Current process platform and architecture |
| `workspace` | Bound source project and execution directory |
| `agents` | Self, related instances, counts and bounded plugin coordination context |
| `services` | Current Bot connection/source facts, registered MCP servers and MCP App context |
| `processes` | Session-owned terminal identity/state and current background tool jobs; no raw commands or output |
| `capabilities` | Effective request permission mode, interactive-request availability and read-only guard; unknown is `null` |

The Agent section includes only the current family and matching source project/workspace. At most 64 related instances and 16,000 characters of coordination context are projected, with counts/truncation reported. The current Agent and active executions take priority over completed records. This is local to one Runtime host. Remote worker sessions are not fabricated as local running agents. Registered MCP servers describe a catalog, not a successful live browser connection or permission to call every tool.

Product requests enable `metadata.environmentContext`; children and Shadow inherit the product request. Assistant uses the same environment directly. Low-level model calls/internal tasks can opt in when environment observations are relevant, while pure transformations need not pay for unrelated context. All executions are registered regardless of whether observations are requested.

At a normal model boundary the environment appends an internal **user** message named `runtime_environment`. The first observation is a snapshot; later messages contain only changed sections. Unchanged facts add no message. Removed sources emit `null`. Historical messages and the frozen system prefix are never rewritten. After compaction removes structured observations, a fresh snapshot is supplied. Observations cannot trigger another turn or bypass a safe tool boundary.

These messages are host facts, not human requests or authorization. Peer text remains untrusted task data. Historical message timestamps and authored message source identity remain attached to their inputs; current Bot availability belongs to the environment. Durable MCP App events and collaboration messages remain event streams, distinct from current state.

## Adding a source or execution adapter

Use `environmentSources: { sectionName: async ({request, signal}) => jsonFacts }` when constructing a host. Sources should be scoped, bounded, cancellation-aware and free of secrets. Each observation has a one-second deadline and a 65,536-character JSON limit. Failed, timed-out or non-serializable sources become `{ "status": "unavailable" }`; cancellation still cancels the request. Oversized observations include `reason: "snapshot_too_large"`. Sources cannot replace the reserved core sections. Refreshing a source must not start work.

New execution mechanisms use the registry lifecycle (`begin`, `update`/`observe`, `forget`) and keep their own resource controls. Do not create another presence map or infer execution from a saved configuration. Use exact execution IDs for asynchronous completion. Scheduling/messaging adapters continue to enforce their existing authority separately.

## Verification

`packages/bush-runtime/test/runtimeEnvironment.test.mjs` covers lifecycle, stale completion, bounded retention, scope/privacy, incremental facts, cancellation, the read API, actual concurrent parent/Shadow execution, and Assistant registration. Existing conversation, permission, MCP App, child/Team, recovery, AgentChatroom and CLI tests verify their own execution contracts through the shared state.
