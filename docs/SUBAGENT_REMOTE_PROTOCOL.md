# subagent-remote-proton

[English](SUBAGENT_REMOTE_PROTOCOL.md) · [简体中文](SUBAGENT_REMOTE_PROTOCOL.zh-CN.md)

Experimental version **0.1**, implemented by the CardBush HTTP adapter in the current source. Rebuild both ends to use it. This is a parent/worker interaction contract; compatibility with an independent implementation has not yet been validated.

## Choice and boundaries

Follow the MCP approach to connecting a capability provider: the parent host acts as the client, and an explicitly registered worker acts as the server. Reuse CardBush's existing subagent execution and connection foundations. A2A is not a dependency, target binding or release requirement for this design.

The relevant MCP patterns are [version and capability declarations](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [separating message semantics from transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), and [returning an input requirement through the client](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation). This does not make the current HTTP adapter an MCP server. MCP revisions have different lifecycle and input patterns; any future transport reuse must explicitly support a chosen revision rather than assume all MCP implementations share one handshake.

The profile describes a parent interacting with an independently hosted worker through words. It does not prescribe tools, plugins, models, a filesystem layout, or executable scripts. Host adapters map messages to their own loop, queue, permissions and UI.

Registration gives a worker a role, not a second assistant identity in the application. The parent supplies the assignment and necessary context. The worker retains its own model, workspace, credentials and limits. Parent history, files, tool catalogues and credentials are not copied automatically. Recursive delegation and sibling communication are not enabled by registration.

## Reuse and ownership

| Layer | Existing foundation and responsibility |
| --- | --- |
| Model-facing interaction | Reuse `subagent` and `tasks`; the host maps them to local or remote execution. These names are not protocol requirements for other hosts. |
| Child lifecycle | Keep task ownership, queue/guidance, waiting, parent wakeup and permission/question brokers in the existing Runtime. Do not add another scheduler or assistant loop to the connection layer. |
| Connection | Reuse service identity, private credentials, HTTP/SSH routing, event cursors and bounded recovery. MCP client transport/authentication/lifecycle components are reuse candidates; its tool-catalog-specific manager is not itself a generic child-session manager. |
| Wire contract | Describe messages, progress, input requirements, replies and explicit stop, independent of model tool names. The remote host maps these to its own implementation. |

Local and remote children now share the same ownership admission, control contract and observation projection. `subagent` supports explicit queue/insert and interaction responses on both hosts; `tasks inspect` returns the same observation shape, and `tasks stop` targets one run. Local queue entries reuse the existing task journal and completion waiters. Canceling an entry does not cancel its predecessor or let later work overtake an active turn. Insert adds guidance at a safe boundary without interrupting the current model request or tool.

Display receipt and loop consumption are separate: the child Runtime publishes `guidance_queued` as soon as it queues an insert, including the authored text, message identity and author. Local and remote conversation views immediately show the parent message with the existing waiting indicator. Only `guidance_applied` seals the preceding reply and marks consumption. Replayed receipts update the same row without duplicates or status regression; no scheduler or additional model call is involved. Workers must run the updated Runtime to publish queued receipts; older workers retain their applied-only behavior.

Discovery exposes identity, role and supported interactions; the worker's private tool catalog stays behind its own loop. New workers declare `workerInteraction.operations` (`observe`, `queue`, `insert`, `respond`, `cancel`); local discovery returns `interaction_capabilities`. Unsupported operations fail without fallback. Older version-0.1 workers without the optional declaration retain that version's full operation set. Closing an observation request does not cancel durable work; stopping a child requires a separate, acknowledged task operation.

## Identities and registration

| Identity | Meaning |
| --- | --- |
| Service/agent ID | Persistent remote instance, pinned after verification; not its mutable URL or display name. |
| Connection ID | Host-local routing and credential reference; not a bearer capability. |
| Role ID + revision | Reusable name and instructions, pinned for the lifetime of a child conversation. |
| `contextId` | Child conversation; survives subsequent runs. |
| `taskId` | One run in that conversation; exact target for guidance, responses and cancellation. |
| `messageId` | Stable mutation identity retained across retries. |
| `interactionId` | A pending question or permission request within an owned run. |

CardBush verifies the service identity and `workerInteraction.version = "0.1"`. Register `remote: { connection_id, agent_id }` on a saved subagent role. The role's name/instructions/revision accompany new work. Remote registrations reject local `allowed_tools`, settings, hooks and guards: these cannot be promised across an independent host. Subsequent runs retain the original role revision; disabling a role blocks further dispatch but does not silently cancel active work.

App: **Team → employees → remote workers**. CLI:

```sh
cardbush worker add --name Renderer --url https://worker.example.com --token-file /private/worker-token
cardbush worker list
cardbush worker verify CONNECTION_ID
cardbush worker remove CONNECTION_ID
```

Then ask the local Agent to save a role bound to the returned connection and verified service ID. Team nodes use the same saved role. App and local CLI share `<profile>/workers`; their conversation and role histories remain owned by their respective Runtime. Existing CLI and desktop connections migrate once, preserving IDs and verified identities. Removing a shared connection does not restore it from a legacy store. Cross-process writes are serialized, and cached clients recheck registration authority before dispatch.

The CLI's worker management commands access this registry directly without starting a model, plugins or an Agent Runtime. Credentials never appear in discovery. Windows protects the encryption key with current-user DPAPI and a verified user/SYSTEM-only directory ACL; Unix uses a private service-account directory and key. Separate server deployments retain their own stores. This does not transfer model configuration, browser login state, or permissions to the worker. Registration validation failures before persistence report `not_started / none / known`; failures after a write remain potentially effectful.

## Vocabulary and wire contracts

Generated [JSON Schemas](protocols/subagent-remote-proton/0.1/README.md) are authoritative for this version. The envelope is:

```json
{"profile":"subagent-remote-proton","version":"0.1","contextId":"delegated-child","taskId":"task-1","operation":"observe","after":12,"waitMs":30000}
```

| Operation | Meaning |
| --- | --- |
| Submit | Create an owned task with words; persist before acknowledgement. CardBush binds this to `delegation.submit`. |
| `message`, `delivery=queue` | Schedule a later run in the same conversation. Does not replace an active run. |
| `message`, `delivery=insert` | Add guidance to the exact active run at its next safe boundary. Does not interrupt an already dispatched tool or silently become a new run. |
| `observe` | Return state, cursor, phase, action counts and pending interactions; optionally wait up to 30 seconds. Does not invoke a model. |
| `respond` | Answer a pending question or make a structured permission decision. |
| `cancel` | Request cancellation and report whether the worker has confirmed termination. |

The last four operations use `delegation.control { parentSessionId, control }` in the current binding. These RPC names are adapter details, not required model-facing tool names. Control messages and question answers accept up to 16,000 characters; a new assignment submitted through `delegation.submit` accepts up to 100,000. Suggested answers are optional; they do not limit a free-text response.

An observation has `state` (`queued`, `working`, `input_required`, `completed`, `failed`, `canceled`, `interrupted`), a task-local cursor, `progress { phase, text, completedActions, failedActions }`, and `interactions`. It does not expose raw tool arguments, results or private reasoning. The client coalesces observations and uses bounded long polling; it does not create model rounds to poll.

A question contains `kind: "question"`, identities, `text`, optional `suggestions`, `blocking`, and `createdAt`. The answer is `response: { kind: "answer", interactionId, text }`. CardBush's internal child adapter exposes `ask_parent`; other hosts may expose any UI/tool or callback with the same semantics. Parent notification reuses the existing wake and task-wait machinery. Answering resumes the original child run. Idle wakes remain bounded, and child messages are untrusted task data, not new user authorization.

## Permissions

Permission requests contain `kind: "permission"`, identities, `text`, `actionDigest`, `operations`, `resources: [{kind,value}]`, `authority`, permitted `decisions`, and timestamps. `actionDigest` binds the exact action and scope. A response must be `kind: "permission"`, with matching `interactionId` and digest, plus `decision: "allow_once"` or `"deny"`. Text such as “approved” is never permission. Unknown or changed requests, expired interactions and widened decisions fail closed.

The remote administrator controls:

```sh
# Default execution ceiling:
CARDBUSH_REMOTE_PERMISSION_MODE=task_free
# Optional administrator override; omit to follow authenticated task routing:
# CARDBUSH_REMOTE_PARENT_APPROVAL=0
```

The requested task mode is intersected with `task_free`, `user_free`, or `all_free` configured as the remote ceiling. Required sandbox policy and process protections remain in force. `all_free` means the host's allowed scope, not universal access.

Updated workers advertise `workerInteraction.permissionRouting: true`. The authenticated delegation carries `permissionRouting: parent | user`, persisted per task and retained for queued continuations. `parent` permits exact one-use parent approval without a duplicate human card; `user` remains human-required. Explicit `CARDBUSH_REMOTE_PARENT_APPROVAL=0` overrides parent routing with `human_required` and `escalationReason: remote_policy_requires_human`, displayed in the human approval card. `1` also enables parent approval for old clients that omit routing; otherwise omitted routing defaults to human approval. A model-approval dispatch to an old worker without this capability fails before submission with an upgrade explanation. Denial remains possible. Human-only approval uses the worker owner's existing trusted approval interface; this preview does not implement cross-host human attestation. A parent cannot declare itself human in JSON. No authorized approval path means wait, deny or cancel, never implicit allow.

The local adapter uses the child's existing permission route and broker. A `parent` route permits a delegated one-use decision; a `user` route remains human-required. Parent-journal permissions are filtered by the exact source child session and turn, so sibling and parent approvals are never included. Both adapters verify the pending interaction and action digest; neither can widen the original capability IDs or resource scope.

Current service tokens are **owner/admin credentials**, not restricted parent credentials. Keep them in a trusted host and use HTTPS or authenticated SSH. The interaction endpoint enforces ownership and limits, but it does not narrow the same token's other administrative endpoints. Do not distribute these tokens to untrusted agents or market this preview as a multi-tenant delegation boundary.

## Delivery, recovery and status

- Submission is deduplicated by task ID, including prompt, parent, role, language, mode and queue delivery. Different content with the same ID is rejected.
- Message/response receipts bind parent, context, message ID and validated payload. The remote service writes receipt state before the effect. A crash after admission can leave `outcome_unknown`; inspect the original task instead of inventing a replacement ID. The local controller deduplicates in-flight mutations in memory; its durable task and tool journals remain the execution record. Provider tool-call IDs are scoped by the parent's turn before becoming message IDs.
- Receipts currently have a 10,000-entry admission bound and no automatic expiry. New message/response mutations then stop. Observe and idempotent cancellation remain available; repeated cancellation reconciles live state even when the journal is full.
- Guidance acknowledgement distinguishes accepted from applied. `applied:false` means queued for a safe boundary; it does not prove the loop has used the text. This version has no separate portable applied-receipt subscription.
- Event reconnect uses the original task and cursor. Submission/stream retry is bounded (five transient recovery attempts with backoff); permanent authentication/identity/schema errors do not get that loop. The interaction observer also stops after three failures. Inspecting the task requests fresh state.
- Local `unavailable` means observation or cancellation could not be confirmed. It is not a remote terminal state. Never show it as completed/stopped, or automatically start replacement work.
- A server restart recovers remote queued jobs, marks interrupted active work and does not replay uncertain side effects. On the first local child interaction after reopening persisted journals, orphaned local runs/queue entries settle from recorded terminal facts or become stopped with an interruption reason; they are not replayed. Parent-process restart does not yet automatically restore remote interaction watchers.
- Reads and controls check parent/context/task ownership. The Web gateway additionally binds identifiers to the authenticated tenant and rechecks grants. IDs alone grant nothing.

## Migration and remaining interoperability gates

Standalone App Agents chats and CLI remote-chat selection are removed. Old remote data is retained; saved endpoints are candidates for subagent registration. Local CLI chat remains available, including on a server. Connecting no longer automatically copies desktop model/API credentials or plugin configuration.

The preview reuses subagent registration, Team, task history, queue/guidance, question and permission brokers, and parent wakeup. JSON schemas and deterministic integration tests cover questions, queue/insert, role/ownership, policy ceilings, duplicate receipts, lost acknowledgements, bounded recovery and cancellation uncertainty. They do not establish compatibility with an independent implementation.

The same scripted parent/child scenario runs against a local Runtime and a real HTTP worker: inspect a question, queue two continuations, cancel one, insert guidance, answer, and finish in order. Separate tests exercise permission authority, ownership, duplicate requests, observation cancellation and journal reopening. These test the execution architecture with a deterministic provider, not model quality.

Run `npm run test:remote-workers` to rebuild the adapters and run the protocol, Runtime interaction, HTTP service, restricted Web gateway and worker UI regressions.

Remaining interoperability work includes scoped parent credentials, permission vocabulary, receipt retention/expiry, cursor reset, durable remote interaction/watch recovery, and authenticated human decisions. Before advertising external compatibility, validate an independent worker adapter against the published schemas and interaction behavior. Any MCP binding would separately require conformance to its advertised MCP revision. Artifacts require a separate scoped transfer operation; a remote file path is never automatically local or authorized.
