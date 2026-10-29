# Source rationale notes

[English](SOURCE_MEMOS.en.md) · [简体中文](SOURCE_MEMOS.md)

[中文](SOURCE_MEMOS.en.md) | [Documentation](README.md)

Source is toggled in composer `+`, saved per conversation and enabled for new conversations. Send/queue/retry preserve submission-time state. It controls final-answer explanatory annotations, not ordinary files, media, web, extracted or message references.

## Prompt and cache

- System instructions describe purpose/entry; tool definitions carry format. The catalog does not change with the toggle.
- Internal user message `source_preference` appends the current state; off explicitly forbids creating/adding notes. Original user prose remains unchanged.
- Previous messages/results/Source records are immutable. Compaction restores current state, and guidance appends its own state.
- Tool additions/definition changes affect that version's stable prefix; same-version toggles preserve the existing chain. Documentation changes do not rewrite old receipts/notes.

## Writing and display

`remember_source.explanation` adds a short natural-language reason beyond the answer: why a change is needed, consequences of leaving it, how evidence supports the judgment, or a choice's tradeoff. Do not repeat change lists, test counts or the answer. Create no note without added explanatory value. Distinguish necessities from implementation choices; do not invent reasons, impose templates or present one possible design as the only option.

For example, an answer says a disconnected WebSocket client is now removed. A useful note explains that sharing a closing/cleanup flag previously skipped notification, while separate flags make cleanup happen once. “Changed flags; four tests passed” adds no rationale. Keeping a buffer alive until send completes is a necessity; choosing a four-slot pool is a design choice to justify.

`sources` identifies real evidence/constraints, not merely changed files, or is empty for the Agent's own design rationale. A note may link several files/HTTP(S) URLs. Put the returned `[number](cardbush-source:…)` beside the relevant prose, preserving the full link. It does not replace deliverable links or hide essential conclusions/limits; the answer remains independently readable without duplicating note text.

Storage reuses ToolExecutionStore and locator indexes. `cardbush-source:` is distinct from `cardbush-memo:` with separate parsers. Execution-identity validation prevents cross-host number collisions. Resolution currently stays within the owning Runtime; cross-host migration does not automatically transfer notes. `read_source_memos` retrieves original notes with pagination.

Display numbers increment independently per conversation from one; file memos do not consume them. Persistence locators are separate: `cardbush-source:v2:display-number:locator-number-identity-check`. Hover/cache/copy/cleanup use full references, not bare numbers across sessions. A retried call reuses its reservation; interrupted reservations are not reclaimed and numbering continues after restart.

Legacy `cardbush-source:old-number-identity-check` remains valid without rewriting history. Existing sessions continue after their maximum number. Forks retain only inherited Turn numbers and continue from them; later uninherited Turns do not affect the fork. Bare `[number]` is repaired only from successfully saved Source records in the current session/Turn (including inherited fork records). Unknown/ambiguous numbers remain prose; cross-session references require full links.

File records contain size/mtime. Up to 2 MiB, they also include SHA-256 and bounded UTF-8 line excerpts. Larger files can record whole-file metadata but no line excerpts. URLs are not fetched automatically; Agent notes are not independent verification. File reads follow workspace access policy. Fingerprints/excerpts are not redundantly returned to the model.

Rendering preloads notes and coalesces short-term reads per Runtime. Hover/focus uses loaded data without model/network requests. Click opens files/pages; changed/deleted files still show original rationale/excerpts. Cards support pinning, Escape/outside dismissal and themes.

The main card separates rationale and sources; a secondary original-quote card labels the saved-at-authoring excerpt. Entries show filename/type icon/line or page, with full paths in tooltips and normal local-file context menus. Hover/Original opens a side card, flipping or moving below when needed while retaining both layers. Pointer/arrow navigation and layered Escape use preloaded content, without a Back button.

Current display supports line numbers/historical excerpts and opens the current file. Locator fields reserve page/object/region, but precise jumps, PPT/image-region interaction and user-triggered further explanation are future integrations, not automatic follow-up requests.

## Checks

- `packages/bush-runtime/test/sourceMemo.test.mjs`: numbering, file isolation, retry/restart, legacy compatibility, forks, version/missing-file/input cases; `cacheMaintenance.test.mjs`: full-reference retention across sessions.
- `packages/bush-product-agent/test/conversationPreferencesLifecycle.test.mjs`: toggle, actual provider prefix, compaction/restart.
- `scripts/test-source-memo-ui.mjs`: Markdown, same display number in two sessions, full-link copy, preloading/hover, keyboard/click, legacy/theme/narrow UI.
- `scripts/test-subagent-conversation-ui.mjs`: child switches and guidance/queue preference snapshots in shared components.
