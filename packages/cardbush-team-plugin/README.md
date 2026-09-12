# Team plugin

Independent CardBush native plugin. Source, configuration UI, file storage and the existing `team_delegate` implementation live in this package. `team_chat` and free discussion are not implemented.

From the repository root:

```sh
npm run build:team-plugin
```

This writes `release-plugins/team-0.2.0.zip`. Install it through Plugins → Install from ZIP, or install the built `plugin` directory. Updating the ZIP does not require rebuilding the desktop. The host must support CardBush Runtime plugin API 1.

`plugin/.codex-plugin/plugin.json` declares two self-contained ES modules: the native Runtime entry and the browser UI entry. Both are bundled with their dependencies; the installed plugin needs no npm install, local checkout, or external MCP process.

Configuration remains in the host's `plugin-data/team/teams.json`. Uninstalling the package preserves this file. The UI imports and exports JSON/YAML and detects conflicting file edits. The host provides the data root explicitly; the plugin never derives it from the installation directory.

The native extension runs with the Runtime process's privileges. This is the CardBush native extension format, not a portable MCP service or an OpenAI-hosted connector. Install code from sources you trust.
