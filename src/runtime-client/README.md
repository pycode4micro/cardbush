# CardBush Runtime Client boundary

This directory belongs to the CardBush product layer. It adapts structured
Runtime protocol values for React features without implementing Agent Runtime
semantics.

The shared `bush-protocol` package remains the source of truth. Once that
package is available, production code must pass its event and response decoders
to `RuntimeClient`; this directory must not duplicate protocol schemas.

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

`FixtureRuntimeTransport` deliberately accepts raw fixture values. Runtime-owned
decoders validate those values before any feature receives them, so fixture UI
work fails at the same contract boundary as the live Runtime Host.
