# Plugin removal

[English](PLUGIN_UNINSTALL.en.md) · [简体中文](PLUGIN_UNINSTALL.md)

Disabling stops loading while retaining installed files, configuration and data. For a user-installed plugin, the main process accepts the plugin ID, reads the current installation and reports success only after:

1. Disabling loading under the existing Apps configuration lock and setting `removalPending`, without a second installation record or cleanup database.
2. Confirming the Runtime has no active turn or plugin command, cancelling the plugin's background hooks, releasing native extensions, and waiting for MCP connections and process trees to exit.
3. Removing the plugin's OAuth cache and private secret references, while preserving shared accounts and references used by other plugins or standalone MCP connections.
4. Deleting `userData/plugins/<id>`, `userData/plugin-data/<id>` and Runtime `plugin-data/<sha256(id).slice(0,24)>`. Only direct real directories under managed roots are accepted; junction escapes are rejected. Original archives, source folders, marketplace sources and workspace outputs are not installation directories.
5. Removing the Apps configuration record. Reinstallation starts with fresh configuration.

Installation and removal share a lifecycle queue. Filesystem operations use a separate short queue so directory reads do not deadlock with Runtime cleanup. The configuration lock prevents an old draft from overwriting removal.

Busy execution, connection cleanup failure or file deletion failure produces an incomplete-removal state, not success. A disabled retry entry remains. Even after partial deletion, restarting permits cleanup to continue without reloading leftover capabilities.

Bundled components offer Disable rather than claiming to uninstall files that remain in the app package. Removing a plugin does not delete conversation or tool history.

`npm run test:plugin-uninstall` covers actual MCP shutdown, Runtime native-command ownership, background hooks, directory escapes, partial-removal retries, configuration conflicts, reinstallation and UI behavior.

Historical validation on September 15, 2026 passed the removal suite, 14 Product Host tests and frontend/backend type checks. A separate `test-plugin-openai-hooks.mjs` check saw an extra `PreCompact` event; the pre-change HookRunner/InMemoryRuntimeHost reproduced it as well. That removal change did not modify compaction behavior.
