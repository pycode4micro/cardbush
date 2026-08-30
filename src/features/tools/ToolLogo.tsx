import {
  BookOpenCheck,
  Brain,
  CalendarClock,
  FilePenLine,
  FilePlus2,
  FileText,
  GitFork,
  Hourglass,
  Image,
  ListChecks,
  ListTodo,
  Lightbulb,
  Search,
  ShieldCheck,
  SquareTerminal,
  Target,
  UsersRound,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import mcpLogoUrl from '../../assets/integration-logos/mcp.svg';

type ToolLogoDefinition = {
  icon: LucideIcon;
  tone: string;
};

const toolLogos: Record<string, ToolLogoDefinition> = {
  read_file: { icon: FileText, tone: 'files' },
  write_file: { icon: FilePlus2, tone: 'files' },
  edit_file: { icon: FilePenLine, tone: 'files' },
  search_file_content: { icon: Search, tone: 'search' },
  terminal_exec: { icon: SquareTerminal, tone: 'terminal' },
  search_skills: { icon: BookOpenCheck, tone: 'skills' },
  consult_logic: { icon: Brain, tone: 'reasoning' },
  learn_logic: { icon: Lightbulb, tone: 'reasoning' },
  read_archived_tool_result: { icon: FileText, tone: 'knowledge' },
  inject_image_input: { icon: Image, tone: 'vision' },
  schedule_task: { icon: CalendarClock, tone: 'schedule' },
  parallel_tools: { icon: Workflow, tone: 'agents' },
  subagent: { icon: GitFork, tone: 'agents' },
  await_subagents: { icon: Hourglass, tone: 'agents' },
  team_delegate: { icon: UsersRound, tone: 'agents' },
  update_task_plan: { icon: ListChecks, tone: 'planning' },
  update_goal: { icon: Target, tone: 'planning' },
  request_permission: { icon: ShieldCheck, tone: 'permission' },
  request_user_choice: { icon: ListTodo, tone: 'permission' },
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
      <img
        className={`tool-logo tool-logo-mcp ${className}`.trim()}
        src={mcpLogoUrl}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    );
  }
  const definition = toolLogos[normalized] ?? { icon: Wrench, tone: 'default' };
  const Icon = definition.icon;
  return (
    <Icon
      className={`tool-logo tool-logo-${definition.tone} ${className}`.trim()}
      size={size}
      strokeWidth={1.8}
      aria-hidden="true"
    />
  );
}
