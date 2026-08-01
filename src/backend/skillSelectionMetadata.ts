export function applyAllowedSkillsToRequest(
  body: Record<string, unknown>,
  metadata: Record<string, unknown>,
  allowedSkills: string[] | undefined,
) {
  if (!allowedSkills || allowedSkills.length === 0) {
    return;
  }
  body.allowed_skills = allowedSkills;
  metadata.allowed_skills = allowedSkills;
  delete metadata.skills;
}
