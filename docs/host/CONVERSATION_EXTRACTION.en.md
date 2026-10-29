# Conversation extraction and Fork

[English](CONVERSATION_EXTRACTION.en.md) · [简体中文](CONVERSATION_EXTRACTION.md)

Right-click a sidebar conversation and choose Extract conversation, or use `Ctrl+Shift+E` (customizable). Title/description are optional, but both are required for permanent storage and inclusion in the composer's `@` list.

Default selection is the last five committed turns. A complete turn summary takes precedence over its final reply; a partial checkpoint keeps the summary plus visible replies after it. Without a summary, use user messages and visible Agent replies, never hidden reasoning/system instructions. Over budget, reduce the default by whole oldest turns; do not silently truncate individual messages.

Choose Select to return to the source conversation. Circular selectors appear beside user messages and Agent replies; one Agent turn is one selectable reply. Finish selection returns to the save dialog. The top bar can return from another conversation to the source.

## Save and reference

- **Save as Markdown:** choose a location in the system dialog and write an independent `.md` file.
- **Temporary:** content lives in a temporary `.md`, with metadata in the database. A lightbulb is available in any main-window composer for 30 seconds and inserts once. Unused extracts expire; inserted files last for the current app run. Exit deletes temporary extracts, and next startup cleans crash leftovers.
- **Permanent:** the database stores title, description, source conversation and selection keys, not copied transcript text. `@` selection or opening a chip generates Markdown on demand. Deleted sources or replaced selected content produce explicit errors.
- **Drag a conversation:** insert a default reference from the sidebar, including self-reference. The selected turn set is fixed and excludes later messages referencing itself. It survives restart but does not enter the permanent `@` list.

Reference chips open Markdown in the right panel. Sending resolves actual paths and source descriptions for the Agent's file reader under existing permissions. Reference material never becomes host instructions.

## Budget and storage

The budget is one quarter of the selected model context, including title, description, markup and body. UTF-8 byte length is a conservative text-token upper bound, explicitly labeled as an estimate, not provider billing tokenization. It avoids underestimating Chinese with characters/4. Selection, save and send all check it; multiple extracts sent together share the bound.

Metadata lives in `conversation-extracts/extracts.sqlite` under app data; generated files are in its `files` directory and cleaned at exit. Permanent/drag references regenerate from the source.

## Fork and tests

Fork creates and switches to an independent conversation, copying committed messages, summaries, supersession history and tool-result records, excluding a currently generating turn. It has independent identity/workspace settings and does not inherit active tasks, permission requests, Goal, subagent relations, provider response cache or source-workspace undo operations. It never reruns tools; historical attachments reference original files.

`npm run test:conversation-extraction` builds Runtime/Electron and checks backend data/budgets/references/Fork plus UI interaction: context menu, shortcut, selection, all save modes, cross-conversation lightbulb/expiry, `@` chips, preview, drag, self-reference and Fork.
