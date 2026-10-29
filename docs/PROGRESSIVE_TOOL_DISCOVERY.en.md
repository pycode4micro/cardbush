# Progressive tool discovery

[English](PROGRESSIVE_TOOL_DISCOVERY.en.md) · [简体中文](PROGRESSIVE_TOOL_DISCOVERY.md)

Discovery returns available object IDs, short purposes and necessary state. Registered agents, teams and schedules execute their saved configuration; read full definitions only when inspecting or editing them. Saves return IDs and revisions rather than echoing long submitted instructions.

| Entry point | Default discovery/state | Details on demand |
| --- | --- | --- |
| `list_subagent_options` | Summaries of registered agents, plugin roles and remote Agents | `agent_id` reads a definition; `agent_type` reads a plugin role; `section: "settings"` reads models, defaults and trusted hooks; `section: "tools"` searches the tool scope. |
| `list_plugin_commands` | Purpose, argument hints and eligibility | `command` reads one command's full description/hints; `run_plugin_command` executes it. |
| `team` | `list` returns workflow summaries; execution state comes from `tasks` | `get` reads configuration; `list` with `section: "runs"` lists this session's runs; `tasks inspect/wait` reads results; `node_ids` selects node outputs. |
| `tasks` | `list` returns this session's background states and result availability | `inspect` with `task_ids` reads selected results; `wait` waits and reads. |
| `schedule_task` | `list` returns names, triggers, state and the latest run state | `get` with `job_id` reads editable configuration; `scheduled_results` reads outputs. |
| `scheduled_results` | Short execution summaries | `run_ids` reads selected saved results in full. |

Directory queries support `query`, `offset` and `limit`: 20 entries by default, at most 50, with roughly 6,000 characters per page. Preview descriptions are bounded, but search uses full descriptions. Keep the query unchanged and pass `next_offset` as `offset`; `null` ends pagination. `list_subagent_options` paginates agents/tools, not a single definition or settings. `scheduled_results` has no search, uses at most 20 entries per page and also returns `next_offset`.

`mcp_search` only searches. `get_tool_schema` loads built-in and MCP schemas through one entry. Skill search returns descriptions and file references; bodies are read on demand. Execution history also uses summaries and archive locators.

These rules affect model-facing discovery and management receipts. Configuration UI, persisted definitions, permissions and execution still use full data. Explicitly requested long definitions and results remain accessible through Runtime result archives.
