import type { PluginCommandSummary, SkillSummary } from '../../types';
import { isAbsoluteLocalPath } from '../../shared/localPaths';

export type SkillLinkReference = { title: string; path: string };
export type SkillPromptPart = { text: string; start: number; skillReference?: SkillLinkReference; skill?: SkillSummary; skillCommand?: PluginCommandSummary };

export function skillReference(skill: Pick<SkillSummary, 'name' | 'path'>): string {
  const label = skill.name.replace(/([\\\[\]])/g, '\\$1');
  const path = skill.path.replaceAll('\\', '/').replaceAll('>', '%3E').replaceAll('<', '%3C');
  return `[${label}](<${path}>)`;
}

/** Display Skill links and catalog-backed invocations as tokens without changing
 * their source text. Plugin invocations must remain commands for Runtime policy,
 * argument expansion and Hooks; a SKILL.md link is not an equivalent invocation. */
export function skillPromptParts(value: string, skills: SkillSummary[], commands: PluginCommandSummary[] = []): SkillPromptPart[] {
  const parts: SkillPromptPart[] = [];
  const pathKey = (path: string) => {
    const normalized = path.replaceAll('\\', '/');
    return /^(?:[A-Za-z]:\/|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const byPath = new Map(skills.map(skill => [pathKey(skill.path), skill]));
  let cursor = 0;
  // Runtime invokes a command only at the start of the user message. Do not turn
  // examples, partial IDs, ambiguous aliases or ordinary plugin commands into Skills.
  const invocation = /^(\s*)([/$]([A-Za-z0-9_.-]+(?::[A-Za-z0-9_-]+)?))(?=\s|$)/.exec(value);
  const matches = invocation ? commands.filter(command => command.id === invocation[3] || command.name === invocation[3]) : [];
  const command = matches.length === 1 && matches[0].kind === 'skill' ? matches[0] : undefined;
  if (invocation && command) {
    const skill = command.path ? byPath.get(pathKey(command.path)) : skills.find(skill => skill.name === command.id);
    const start = invocation[1].length;
    if (start) parts.push({ text: value.slice(0, start), start: 0 });
    parts.push({ text: invocation[2], start, skillCommand: command, skill,
      skillReference: { title: command.name || command.id, path: command.path || skill?.path || '' } });
    cursor = start + invocation[2].length;
  }
  // Consume code first so examples, escaped links and images stay literal.
  const pattern = /(^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n|$)[\s\S]*?(?:^[ \t]*\2[`~]*[ \t]*(?:\r?\n|$)|$(?![\s\S])))|(`+)[\s\S]*?\3(?!`)|\[((?:\\.|[^\]\\\r\n])+)\]\((?:<([^>\r\n]+)>|([^\s()]+))\)/gm;
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

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[];
  position?: { start: { offset?: number; column?: number }; end: { offset?: number; column?: number } };
  data?: { hProperties?: Record<string, string>; originalLiteral?: string } };

/** Escape Markdown punctuation only in a confirmed invocation. A command name
 * such as /demo:_review_ is an identifier, not emphasis. Authored text stays intact. */
export function skillMarkdownPresentation(content: string, commands: PluginCommandSummary[] = []) {
  const invocation = commands.length ? skillPromptParts(content, [], commands).find(part => part.skillCommand) : undefined;
  if (!invocation) return { content };
  const prefix = content.slice(0, invocation.start);
  const indentation = prefix.slice(Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r')) + 1);
  if (!/^ {0,3}$/.test(indentation)) return { content }; // Indented code stays literal.
  return { invocation, content: prefix + invocation.text.replaceAll('_', '\\_') + content.slice(invocation.start + invocation.text.length) };
}

/** Presentation only: retain the authored invocation for copy/edit/send and
 * Runtime policy. Only the leading, catalog-confirmed Skill becomes a token. */
export function remarkSkillCommands({ invocation: part }: { invocation?: SkillPromptPart }) {
  return (tree: MarkdownNode) => {
    const paragraph = tree.children?.[0], first = paragraph?.children?.[0];
    if (!part?.skillReference || paragraph?.type !== 'paragraph' || first?.type !== 'text' || !first.value?.startsWith(part.text)) return;
    const remaining: MarkdownNode[] = [];
    if (first.value.length > part.text.length) {
      const rest = { ...first, value: first.value.slice(part.text.length) };
      const sourceLength = part.text.replaceAll('_', '\\_').length;
      // Later citation parsing compares decoded text with its original source.
      // Move both representations past the command, including escaped underscores.
      if (first.position) rest.position = { ...first.position, start: { ...first.position.start,
        offset: first.position.start.offset === undefined ? undefined : first.position.start.offset + sourceLength,
        column: first.position.start.column === undefined ? undefined : first.position.start.column + sourceLength,
      } };
      if (first.data?.originalLiteral !== undefined) rest.data = { ...first.data, originalLiteral: first.data.originalLiteral.slice(sourceLength) };
      remaining.push(rest);
    }
    paragraph.children!.splice(0, 1, {
      type: 'link', url: part.skillReference.path || '#',
      children: [{ type: 'text', value: part.skillReference.title }],
      data: { hProperties: { 'data-skill-command': part.text, 'data-skill-path': part.skillReference.path } },
    }, ...remaining);
  };
}
