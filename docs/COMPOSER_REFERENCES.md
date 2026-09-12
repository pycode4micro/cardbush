# Composer discovery and references

- `/` groups quick actions, installed plugins, skills and plugin commands. Display names omit command prefixes; invocation IDs are unchanged. Skills use their own icon when provided, otherwise their owning plugin's icon. `$` remains an installed-plugin shortcut.
- `@` lists the native attachment picker, currently open CardBush browser tabs, and user instructions from **the current conversation only**. Assistant/tool messages, replaced messages and undelivered drafts are excluded. Choosing files opens the existing system attachment dialog.
- Browser selections capture the current title, URL and tab identity. Later navigation never rewrites a selected reference. Clicking a sent reference reuses its tab if the URL still matches, otherwise opens the captured URL. No page body or other tabs are automatically attached.
- User selections carry session, turn and message identity in an explicit Markdown link. On submission, the source is read from the Session or the unfinished Turn's durable checkpoint. Only that user instruction and its attachment metadata are included, never the entire Turn. Missing or replaced sources produce a visible error.

## Persistence and context

The selected source facts are appended to the **new user message** once. Original authored Markdown is stored as `composerReferenceContent` presentation metadata, so the UI, copying, editing and history restoration keep readable reference tokens. Runtime retains the already-resolved message; no earlier message, system/developer prefix or tool catalog is changed by selection. Guidance uses the same resolver and persists the same metadata. Referencing a previous reference-bearing instruction uses its authored content rather than recursively copying all of its resolved context.

`runtime.get_user_message` is a typed UI read command, not a new model tool. It reads existing Session/checkpoint facts; it does not maintain a second message store. The browser picker similarly derives its choices from the inspector's existing navigation state.

## Regression checks

`npm run test:composer-references` covers reference identity, literal Markdown, current-conversation scope, full source text, immutable prefix/history, live and committed user facts, guidance, native attachment selection, grouped icons, keyboard/token editing, narrow layouts, saved transcript rendering and inspector navigation. Tests use local fixtures; no model or external account requests are required.
