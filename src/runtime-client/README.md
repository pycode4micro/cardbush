# CardBush Runtime Client boundary

This directory belongs to the CardBush product layer. It adapts structured
Runtime protocol values for React features without implementing Agent Runtime
semantics.

The shared `@cardbush/bush-protocol` package remains the source of truth.
`ProtocolRuntimeClient` injects its event and capability decoders into the
transport-neutral `RuntimeClient`; this directory does not duplicate protocol
schemas.

Allowed responsibilities:

- open a typed Runtime event stream through an injected transport;
- send typed commands through an injected transport;
- expose fixture transports for product and visual tests;
- forward cancellation to the host transport.

Forbidden responsibilities:

- infer state from assistant text or tool names;
- decide whether a Turn, Goal or Subagent is complete;
- retry model or tool requests;
- reorder, merge or fabricate Runtime events;
- access Runtime SQLite storage;
- implement permission or Execution Fact rules.

`FixtureRuntimeTransport` deliberately accepts raw fixture values.
`createRuntimeFixtureClient` validates the complete fixture through the
Runtime-owned decoder before any feature receives it, so fixture UI work fails
at the same contract boundary as the live Runtime Host. `RuntimeTurnProjection`
then projects those validated facts into separate reasoning and assistant
segments and only applies a terminal phase from `turn_terminal`.
