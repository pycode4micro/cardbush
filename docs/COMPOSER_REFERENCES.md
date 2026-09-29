# Composer discovery and references

- `/` groups quick actions, installed plugins, skills and plugin commands. Display names omit command prefixes; invocation IDs are unchanged. Skills use their own icon when provided, otherwise their owning plugin's icon. `$` remains an installed-plugin shortcut.
- `@` lists the native attachment picker, currently open CardBush browser tabs, and user instructions from **the current conversation only**. Assistant/tool messages, replaced messages and undelivered drafts are excluded. Choosing files opens the existing system attachment dialog.
- Browser selections capture the current title, URL and tab identity. Later navigation never rewrites a selected reference. Clicking a sent reference reuses its tab if the URL still matches, otherwise opens the captured URL. No page body or other tabs are automatically attached.
- User selections carry session, turn and message identity in an explicit Markdown link. On submission, the source is read from the Session or the unfinished Turn's durable checkpoint. Only that user instruction and its attachment metadata are included, never the entire Turn. Missing or replaced sources produce a visible error.

## Long pasted text

Pasting more than 8,000 UTF-16 characters or 200 lines creates a UTF-8 `.txt` attachment. CRLF and CR line endings count as one line break and remain unchanged in the file. Short text keeps normal editing behavior; clipboard files and images keep their existing attachment flow. The original draft and rich reference tokens are preserved.

The composer keeps only the file reference, byte size, line count and a copied preview of at most 160 characters. The card supports read-only preview and removal. File creation/upload blocks submission; a failure leaves the original clipboard available for retry and shows an error. Async results stay scoped to the conversation where the paste occurred, including when switching conversations during upload.

Desktop files live under the application data directory at `attachments/pasted-text/<id>/`. Agent files live in the conversation workspace at `.cardbush-attachments/pasted-text/<id>/`, using authenticated `files.pasted-text` operations with 512 KiB chunks (maximum 64 MiB per text attachment). Only the target host's returned path is sent; desktop paths are never substituted for remote paths. Both desktop and Agent service must be updated for remote pasted-text attachments.

Sending includes the attachment path, not its full text. The model reads or searches the file on demand. Pasting/encoding/uploading still uses temporary memory; the long text is not kept in the editor or draft state afterward.

Removing an unsent card deletes its generated file. Submitted files are retained at the same path before handoff so queued messages, history, and uncertain network acknowledgements cannot lose their references. Inactive unsent/partial files older than seven days are cleaned on startup or subsequent attachment activity; active drafts are protected for the process lifetime. Attachment cards currently survive conversation switching, not application restart; sent references remain durable. Cleanup is limited to this generated-text store and never removes a user-selected source file.

Validation: `npm run test:pasted-text` covers real file lifecycle, chunk boundaries, model input, and native/rich composer rendering in both themes.

## Persistence and context

The selected source facts are appended to the **new user message** once. Original authored Markdown is stored as `composerReferenceContent` presentation metadata, so the UI, copying, editing and history restoration keep readable reference tokens. Runtime retains the already-resolved message; no earlier message, system/developer prefix or tool catalog is changed by selection. Guidance uses the same resolver and persists the same metadata. Referencing a previous reference-bearing instruction uses its authored content rather than recursively copying all of its resolved context.

`runtime.get_user_message` is a typed UI read command, not a new model tool. It reads existing Session/checkpoint facts; it does not maintain a second message store. The browser picker similarly derives its choices from the inspector's existing navigation state.

## Regression checks

`npm run test:composer-references` covers reference identity, literal Markdown, current-conversation scope, full source text, immutable prefix/history, live and committed user facts, guidance, native attachment selection, grouped icons, keyboard/token editing, narrow layouts, saved transcript rendering and inspector navigation. Tests use local fixtures; no model or external account requests are required.
