# File references and delivery validation

[English](FILE_REFERENCES.en.md) · [简体中文](FILE_REFERENCES.md)

`remember_file` returns a simple session file ID (`file_1`, `file_2`), a link (`cardbush-memo:1`) and ready-to-copy `markdown`. The host allocates link numbers globally so a link resolves to the same record in parent/child conversations, Shadow and historical previews.

The tool-execution directory's `.file-memo-references` stores link numbers and original execution locations, without duplicating content or notes. Writes use fsync and checksums; restarts restore existing numbers. An established-index marker prevents accidental index loss from restarting numbering at 1. Cancellation may leave unused numbers, which are never reassigned. Notes come from immutable execution records; later revisions create new references and retain previous notes.

Legacy links containing conversation, turn and tool-call IDs remain supported. A mistyped historical call ID is recovered only when the source message's conversation, turn and filename match a single candidate within edit distance 2. New numeric links are exact; ambiguous targets are never guessed.

Before final delivery, Markdown file references and accessibility are checked, excluding code examples. An invalid link preserves the original message and completed actions, then appends one internal correction request with accessible links. A second failure reports that the file link needs correction. It does not rerun tools, retry indefinitely or rewrite the cached prefix.

The UI shows a localized explanation and Retry at the link location; normal refresh/retry does not open a system error dialog. Invalid references, inaccessible files, changed files and temporary transport failures are handled separately. Historical recovery uses the message's own provenance, not the currently selected conversation.

Verification: `packages/bush-runtime/test/fileMemo.test.mjs`, `scripts/test-file-memo-ui.cjs`, `scripts/test-markdown-format.mjs`.
