# File references and delivery validation

[English](FILE_REFERENCES.en.md) · [简体中文](FILE_REFERENCES.md)

New messages deliver files with ordinary Markdown links. HTML files open through the preview flow. For remote tasks, link the absolute path of each deliverable in the conversation workspace. Copy an external plugin output into the workspace with the required file access, then use the same verified transfer. File links inside evidence footnotes are excluded from automatic transfer.

Historical `cardbush-memo:` links use the `.file-memo-references` index and original tool execution records. Saved notes, file targets and access boundaries are retained, including historical receipts for files outside the workspace.

Legacy links containing conversation, turn and tool-call IDs remain supported. A mistyped historical call ID is recovered only when the source message's conversation, turn and filename match a single candidate within edit distance 2. Numeric links are exact; ambiguous targets are never guessed.

Final replies still validate legacy Memo destinations and file availability, excluding code examples. An invalid link preserves the original message and completed actions, then appends one internal correction request with accessible links. A second failure reports that the file link needs correction. It does not rerun tools, retry indefinitely or rewrite the cached prefix.

The UI shows a localized explanation and Retry at the link location; normal refresh/retry does not open a system error dialog. Invalid references, inaccessible files, changed files and temporary transport failures are handled separately. Historical recovery uses the message's own provenance, not the currently selected conversation.

Verification: `packages/bush-runtime/test/fileMemo.test.mjs`, `scripts/test-file-memo-ui.cjs`, `scripts/test-markdown-format.mjs`.
