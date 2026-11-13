/** 16 × 16 pixel paths shared by execution rows and the character's handheld props. */
export const pixelToolArt = {
  page: 'M3 1h7v2H5v10h7V6h2v9H3z M10 2h2v2h2v2h-4z M6 7h5v1H6z M6 10h4v1H6z',
  pencil: 'M11 1h2v1h1v1h1v2h-2V4h-1V3h-1z M10 4h2v2h1v1h-2v2H9v2H7v2H5v1H2v-3h1V9h2V7h2V5h2V4z',
  lens: 'M4 1h5v1h2v2h1v5h-2v2H8v1H4v-1H2V9H1V4h1V2h2z M4 4v5h5V4z M10 10h2v2h2v2h1v1h-3v-2h-2z',
  terminal: 'M1 2h14v12H1z M3 4v8h10V4z M4 5h2v1h1v1h1v1H7v1H6v1H4V9h1V8h1V7H5V6H4z M8 10h4v1H8z',
  screen: 'M1 2h14v10H9v1h3v2H4v-2h3v-1H1z M3 4v6h10V4z',
  globe: 'M5 1h6v1h2v2h1v2h1v4h-1v2h-1v2h-2v1H5v-1H3v-2H2v-2H1V6h1V4h1V2h2z M7 3v4h2V3z M4 4v1H3v2h2V4z M11 4v3h2V5h-1V4z M3 9v2h1v1h1V9z M7 9v4h2V9z M11 9v3h1v-1h1V9z',
  book: 'M1 3h5v1h1v1h2V4h1V3h5v10h-5v1H6v-1H1z M3 5v6h3v1h1V6H6V5z M10 5v1H9v6h1v-1h3V5z',
  picture: 'M1 2h14v12H1z M3 4v7h1V9h2V7h2v2h2v2h3V4z M10 5h2v2h-2z',
  clock: 'M4 1h2v2h4V1h2v2h3v12H1V3h3z M3 6v7h10V6z M7 7h2v3h2v1H7z',
  team: 'M1 2h5v4H1z M10 2h5v4h-5z M3 7h1v2h3v1h2V9h3V7h1v4h-4v3H7v-3H3z',
  checklist: 'M5 2h7v2h2v11H2V3h3z M4 5v8h8V5z M5 7h2v2H5z M8 7h3v1H8z M5 10h2v2H5z M8 10h3v1H8z',
  bubble: 'M2 2h12v1h1v8h-1v1H7v1H5v2H3v-3H1V3h1z M3 4v6h10V4z M5 6h1v2H5z M7 6h1v2H7z M10 6h1v2h-1z',
  hourglass: 'M3 1h10v2h-1v3h-2v1H9v2h1v1h2v3h1v2H3v-2h1v-3h2V9h1V7H6V6H4V3H3z M6 3v2h4V3z M7 11v1H6v1h4v-1H9v-1z',
  plug: 'M4 1h2v4h4V1h2v4h2v3h-1v2h-2v1H9v4H7v-4H5v-1H3V8H2V5h2z',
  brush: 'M12 1h3v3h-2v2h-2v2H9v2H7V7h1V5h2V3h2z M4 9h3v2h1v2H7v1H5v1H1v-2h2v-2h1z',
  wrench: 'M10 1h2v2h-2v3h3V4h2v4h-1v1h-2v1H9v1H8v1H7v1H6v1H5v1H2v-1H1v-2h1v-1h1v-1h1V9h1V8h1V7h1V4h1V2h2z',
} as const;
export type ToolProp = keyof typeof pixelToolArt;

const groups: Partial<Record<ToolProp, string>> = {
  page: 'read_file read_files read_archived_tool_result read_conversation_history read_file_memos read_source_memos get_user_directories',
  pencil: 'write_file edit_file apply_patch replace_file page_write',
  lens: 'search_file_content search_execution_history search_plugins get_tool_schema search_tools mcp_search',
  terminal: 'terminal_exec terminal_poll terminal_list terminal_write terminal_stop terminal_observe shell_command',
  globe: 'open_external_url linux_browser_use web_search web_fetch',
  screen: 'linux_computer_use',
  book: 'search_skills check_habit revise_memory remember_source remember_file run_skill list_skills',
  picture: 'inject_image_input view_image',
  clock: 'schedule_task scheduled_results assistant_event friends_read_events friends_pause_event friends_create_event friends_watch_time friends_decide',
  team: 'subagent tasks team team_delegate list_subagent_options run_tools agent_peer_wake agent_peer_context',
  checklist: 'update_task_plan update_goal checkpoint_context runtime_context_compaction',
  bubble: 'ask_parent request_user_input_async summary_for_user',
  hourglass: 'await await_subagents',
  plug: 'call_tool start_mcp_tool list_plugin_commands run_plugin_command mcp_app_resource_read mcp_app_status',
  brush: 'design',
};
const tools = new Map(Object.entries(groups).flatMap(([prop, names]) => names.split(' ').map(name => [name, prop as ToolProp] as const)));
const bundledServers = new Map<string, ToolProp>([
  ['browser_use', 'globe'], ['chrome_devtools', 'globe'], ['cardbush_apps', 'screen'], ['cardbush_management', 'wrench'],
]);
export function builtinToolProp(name: string): ToolProp | undefined {
  const id = name.trim().toLowerCase();
  return tools.get(id) ?? (id.startsWith('mcp__') ? bundledServers.get(id.split('__', 2)[1]) : undefined);
}
export function toolProp(name: string): ToolProp {
  return builtinToolProp(name) ?? (name.trim().toLowerCase().startsWith('mcp__') ? 'plug' : 'wrench');
}
