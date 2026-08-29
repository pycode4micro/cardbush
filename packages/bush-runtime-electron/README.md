# Bush Runtime Electron transport

This package owns the renderer-side transport for the Electron Runtime Host. It
implements the same structural `RuntimeTransport` boundary consumed by the
CardBush product client, but it does not project events into React state.

The transport communicates only through `bush.runtime_ipc.v1` messages. Runtime
events, terminal decisions, retries, permissions, and persistence remain owned by
the Utility Process Runtime. The preload bridge only forwards validated command
and stream envelopes.

Protocol mismatches are exposed as `bush.runtime_error.v1` with
`code: protocol_version_mismatch`; they are never converted into a generic
network message.
