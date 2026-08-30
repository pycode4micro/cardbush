import { useEffect, useState } from 'react';

import codeLogo from '../../assets/skill-logos/code.svg';
import computerLogo from '../../assets/skill-logos/computer.svg';
import dataLogo from '../../assets/skill-logos/data.svg';
import designLogo from '../../assets/skill-logos/design.svg';
import documentLogo from '../../assets/skill-logos/document.svg';
import genericLogo from '../../assets/skill-logos/generic.svg';
import imageLogo from '../../assets/skill-logos/image.svg';
import integrationLogo from '../../assets/skill-logos/integration.svg';
import pdfLogo from '../../assets/skill-logos/pdf.svg';
import presentationLogo from '../../assets/skill-logos/presentation.svg';
import researchLogo from '../../assets/skill-logos/research.svg';
import securityLogo from '../../assets/skill-logos/security.svg';
import spreadsheetLogo from '../../assets/skill-logos/spreadsheet.svg';
import toolingLogo from '../../assets/skill-logos/tooling.svg';
import webLogo from '../../assets/skill-logos/web.svg';
import workflowLogo from '../../assets/skill-logos/workflow.svg';
import { fileUrl } from '../../shared/localPaths';
import type { SkillSummary } from '../../types';
import { skillIconKind, type SkillIconKind } from './skillIconKind';

const generatedLogos: Record<SkillIconKind, string> = {
  document: documentLogo,
  spreadsheet: spreadsheetLogo,
  presentation: presentationLogo,
  pdf: pdfLogo,
  image: imageLogo,
  web: webLogo,
  computer: computerLogo,
  security: securityLogo,
  integration: integrationLogo,
  tooling: toolingLogo,
  design: designLogo,
  data: dataLogo,
  research: researchLogo,
  workflow: workflowLogo,
  code: codeLogo,
  generic: genericLogo,
};

export function SkillIcon({
  skill,
  compact = false,
}: {
  skill: Pick<SkillSummary, 'name' | 'description' | 'descriptionZh' | 'path' | 'logoPath' | 'logoDarkPath'>;
  compact?: boolean;
}) {
  const kind = skillIconKind(skill);
  const generatedLogo = generatedLogos[kind];
  const [customLogoFailed, setCustomLogoFailed] = useState(false);
  useEffect(() => setCustomLogoFailed(false), [skill.logoPath, skill.logoDarkPath]);
  const lightLogo = !customLogoFailed && skill.logoPath ? fileUrl(skill.logoPath) : generatedLogo;
  const darkLogo = !customLogoFailed && (skill.logoDarkPath || skill.logoPath)
    ? fileUrl(skill.logoDarkPath || skill.logoPath || '')
    : generatedLogo;
  return (
    <span
      className={`skill-icon skill-icon-${kind}${compact ? ' compact' : ''}`}
      aria-hidden="true"
    >
      <img className="skill-logo-light" src={lightLogo} alt="" onError={() => setCustomLogoFailed(true)} />
      <img className="skill-logo-dark" src={darkLogo} alt="" onError={() => setCustomLogoFailed(true)} />
    </span>
  );
}
