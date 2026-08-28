# Bush TypeScript Runtime Migration

CardBush owns the production TypeScript Runtime. The frozen Python implementation
at Bush commit `a1e2f2b4` and tag `python-reference-2026-08-29` remains an executable
reference and differential-test oracle during migration.

## Boundaries

- `@cardbush/bush-protocol` owns transport-neutral contracts and frozen-reference
  fixtures.
- `@cardbush/bush-runtime` owns the provider-independent Agent Runtime.
- `@cardbush/bush-provider-openai` adapts OpenAI-compatible wire protocols. It
  disables SDK retries so Runtime recovery remains observable and authoritative.
- React, `src/backend/api.ts`, and Electron `main.ts` do not own the Agent Loop.
- Product integrations such as Browser, Bot, Computer Use, and Office remain MCP
  or CardBush application capabilities rather than Runtime branches.

## Migration order

1. Extract and validate contracts from the frozen Python reference.
2. Normalize provider streams into `bush.model_event.v1`.
3. Implement one provider-independent Turn coordinator.
4. Add tool admission, execution, observation, and authoritative receipts.
5. Add context, Cache Chain, recovery, and persistence.
6. Add Plan, Goal, Subagent, and Team behavior.
7. Put the Runtime behind an Electron utility-process host and typed IPC.
8. Switch production traffic only after historical replay and live A/B gates pass.

Protocol compatibility is evaluated from structured facts, lifecycle events, and
artifacts. Model prose and exact loop counts are observations, not equality keys.

## Product integration checkpoint

`@cardbush/bush-protocol` now exposes `decodeRuntimeEvent` and
`decodeRuntimeCapabilities` for the product-owned `RuntimeClient`. Provider-level
`bush.model_event.v1` remains internal to the Runtime; React consumes the stable
`bush.runtime_event.v1` lifecycle instead.

The first product fixture is
`packages/bush-protocol/reference-fixtures/single-turn-stream.v1.json`. It contains
capability discovery plus a complete accepted → started → reasoning → assistant →
terminal Turn. Its `events` and `commandResponses` fields match the product-side
fixture transport, so the decoded fixture is directly consumable without an
adapter. CardBush does not infer completion from text or stream closure.
