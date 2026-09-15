import type { SkillSummary } from '../../types';
import { isAbsoluteLocalPath } from '../../shared/localPaths';

export type SkillLinkReference = { title: string; path: string };
export type SkillPromptPart = { text: string; start: number; skillReference?: SkillLinkReference; skill?: SkillSummary };

export function skillReference(skill: Pick<SkillSummary, 'name' | 'path'>): string {
  const label = skill.name.replace(/([\\\[\]])/g, '\\$1');
  const path = skill.path.replaceAll('\\', '/').replaceAll('>', '%3E').replaceAll('<', '%3C');
  return `[${label}](<${path}>)`;
}

/** Display explicit local SKILL.md links as tokens, preserving their original
 * Markdown for editing, copying and sending. The catalog only enriches display. */
export function skillPromptParts(value: string, skills: SkillSummary[]): SkillPromptPart[] {
  const parts: SkillPromptPart[] = [];
  const pathKey = (path: string) => {
    const normalized = path.replaceAll('\\', '/');
    return /^(?:[A-Za-z]:\/|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const byPath = new Map(skills.map(skill => [pathKey(skill.path), skill]));
  // Consume code first so examples, escaped links and images stay literal.
  const pattern = /(^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n|$)[\s\S]*?(?:^[ \t]*\2[`~]*[ \t]*(?:\r?\n|$)|$(?![\s\S])))|(`+)[\s\S]*?\3(?!`)|\[((?:\\.|[^\]\\\r\n])+)\]\((?:<([^>\r\n]+)>|([^\s()]+))\)/gm;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    if (!match[4] || value[match.index - 1] === '!') continue;
    let precedingSlashes = 0;
    while (value[match.index - 1 - precedingSlashes] === '\\') precedingSlashes++;
    if (precedingSlashes % 2) continue;
    const path = (match[5] ?? match[6]).replace(/%3C/gi, '<').replace(/%3E/gi, '>');
    if (!isAbsoluteLocalPath(path) || !/[\\/]SKILL\.md$/i.test(path) || /[\x00-\x1f\x7f]/.test(path)) continue;
    const title = match[4].replace(/\\([\\\[\]])/g, '$1');
    if (!title.trim()) continue;
    if (match.index > cursor) parts.push({ text: value.slice(cursor, match.index), start: cursor });
    parts.push({ text: match[0], start: match.index, skillReference: { title, path }, skill: byPath.get(pathKey(path)) });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length || !parts.length) parts.push({ text: value.slice(cursor), start: cursor });
  return parts;
}
