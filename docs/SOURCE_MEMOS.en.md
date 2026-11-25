# Source rationale notes

[English](SOURCE_MEMOS.en.md) · [简体中文](SOURCE_MEMOS.md)

[中文](SOURCE_MEMOS.en.md) | [Documentation](README.md)

Source is toggled in composer `+`, saved per conversation and enabled for new conversations. Send/queue/retry preserve submission-time state. It controls final-answer explanatory annotations, not ordinary files, media, web, extracted or message references.

## Markdown evidence

The model writes markers such as `[^cause]` and their definitions in the same reply. Chat displays them as inline evidence cards with hover, click and keyboard interaction. Definitions can contain file links, web links and quoted excerpts. New footnotes are stored with the message.

## Historical evidence

Existing Memo links, saved excerpts and version metadata resolve from the original execution records. A bare legacy number only binds when confirmed for its conversation and turn. Saved excerpts remain readable if the original file changes or disappears. Cache collection retains records referenced by history.

## Checks

- `packages/bush-runtime/test/sourceMemo.test.mjs`: numbering, file isolation, retry/restart, legacy compatibility, forks, version/missing-file/input cases; `cacheMaintenance.test.mjs`: full-reference retention across sessions.
- `packages/bush-product-agent/test/conversationPreferencesLifecycle.test.mjs`: toggle, actual provider prefix, compaction/restart.
- `scripts/test-source-memo-ui.mjs`: Markdown, same display number in two sessions, full-link copy, preloading/hover, keyboard/click, legacy/theme/narrow UI.
- `scripts/test-subagent-conversation-ui.mjs`: child switches and guidance/queue preference snapshots in shared components.
