import {
  BookOpenCheck,
  CalendarClock,
  FilePenLine,
  FilePlus2,
  FileText,
  GitFork,
  Hourglass,
  Image,
  ListChecks,
  Lightbulb,
  Minimize2,
  Search,
  ShieldCheck,
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
  search_skills: BookOpenCheck,
  read_archived_tool_result: FileText,
  inject_image_input: Image,
  schedule_task: CalendarClock,
  parallel_tools: Workflow,
  subagent: GitFork,
  await_subagents: Hourglass,
  team_delegate: UsersRound,
  update_task_plan: ListChecks,
  update_goal: Target,
  request_permission: ShieldCheck,
  solution_selection: Lightbulb,
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
