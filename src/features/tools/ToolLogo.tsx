import {
  BookOpenCheck,
  CalendarClock,
  FilePenLine,
  FilePlus2,
  FileText,
  GitFork,
  Globe,
  Hourglass,
  Image,
  ListChecks,
  Lightbulb,
  Minimize2,
  Search,
  SquareTerminal,
  Target,
  UsersRound,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import { PluginIcon } from '../../components/PluginIcon';

const toolLogos: Record<string, LucideIcon> = {
  read_file: FileText,
  write_file: FilePlus2,
  edit_file: FilePenLine,
  search_file_content: Search,
  terminal_exec: SquareTerminal,
  open_external_url: Globe,
  linux_computer_use: Globe,
  linux_browser_use: Globe,
  search_skills: BookOpenCheck,
  read_archived_tool_result: FileText,
  inject_image_input: Image,
  schedule_task: CalendarClock,
  run_tools: Workflow,
  subagent: GitFork,
  tasks: Hourglass,
  team_delegate: UsersRound,
  team: UsersRound,
  update_task_plan: ListChecks,
  update_goal: Target,
  request_user_input_async: Lightbulb,
  runtime_context_compaction: Minimize2,
};

export function ToolLogo({
  name,
  size = 16,
  className = '',
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const normalized = name.trim().toLowerCase();
  if (normalized.startsWith('mcp__')) {
    return (
      <PluginIcon
        className={`tool-logo ${className}`.trim()}
        size={size}
      />
    );
  }
  const Icon = toolLogos[normalized] ?? Wrench;
  return (
    <Icon
      className={`tool-logo ${className}`.trim()}
      size={size}
      strokeWidth={1.8}
      aria-hidden="true"
    />
  );
}
