import {
  BookOpen,
  Code2,
  Database,
  FileSpreadsheet,
  FileText,
  Globe2,
  Image,
  Monitor,
  Palette,
  Plug,
  Presentation,
  Puzzle,
  ShieldCheck,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import type { SkillSummary } from '../../types';
import { skillIconKind, type SkillIconKind } from './skillIconKind';

const iconsByKind: Record<SkillIconKind, LucideIcon> = {
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  pdf: FileText,
  image: Image,
  web: Globe2,
  computer: Monitor,
  security: ShieldCheck,
  integration: Plug,
  tooling: Wrench,
  design: Palette,
  data: Database,
  research: BookOpen,
  workflow: Workflow,
  code: Code2,
  generic: Puzzle,
};

export function SkillIcon({
  skill,
  compact = false,
}: {
  skill: Pick<SkillSummary, 'name' | 'description' | 'descriptionZh' | 'path'>;
  compact?: boolean;
}) {
  const kind = skillIconKind(skill);
  const Icon = iconsByKind[kind];
  return (
    <span
      className={`skill-icon skill-icon-${kind}${compact ? ' compact' : ''}`}
      aria-hidden="true"
    >
      <Icon size={compact ? 14 : 17} strokeWidth={1.8} />
    </span>
  );
}
