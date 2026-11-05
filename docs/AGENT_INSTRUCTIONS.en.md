# AGENTS.md and settings entry points

[English](AGENT_INSTRUCTIONS.en.md) · [简体中文](AGENT_INSTRUCTIONS.md)

Settings → Global instructions edits `AGENTS.md` in the app user directory. That file is the sole persistent source of global rules; settings no longer maintain project-specific prompts or read old project-context localStorage.

At the start of each new root task turn, the client reads the text and adds it to the request prefix with the `user` role:

1. The global file applies to all conversations, including projectless sessions and subtasks.
2. Project execution reads `AGENTS.md` files from the filesystem root down to the actual working directory, identifying each file and its scope.
3. More specific rules apply only to their directory subtree. Unvisited deeper directories are not recursively scanned and injected into the entire project; the model reads them when working there.

The actual text is included inside `<INSTRUCTIONS>`, not replaced by a path reminder or injected as a `developer` message. Global instructions precede variable project and working-directory information. Unchanged global text keeps that prefix consistent across conversations; actual cache hits still depend on the provider, model, tool set and other request conditions.

A running turn uses its starting snapshot. New turns reread the files; subtasks inherit the current turn's rules and scope. Saving uses revision validation and atomic replacement. Read/write failures are reported, and stale edits cannot silently overwrite external changes.

UI entry points:

- Add: files, folders and task plans.
- Skills: Settings → Plugins → Skills, or enter `/skill` in the desktop composer or CLI to browse skills and `/plugin` to browse installed plugins. Choosing a skill inserts a reference into the draft. Type `@skill-name` or `@plugin-name` to select a resource directly. Use `/` for commands.
- Collect a workflow as a Skill: type `/collect`, then Enter, Tab or the collection action. The composer inserts a request to summarize the current conversation into an installable skill; edit before sending.
- Git branches: project workspace details, selectable before a task starts and locked during execution.
- Vision: Settings → Models → Model input, retaining the existing global-switch scope.

Regression command: `npm run test:global-instructions`.
