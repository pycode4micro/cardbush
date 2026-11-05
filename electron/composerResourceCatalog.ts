type Skill = { name: string; path: string; description?: string; invocationMode?: string };
type Command = { id: string; name?: string; path?: string; kind?: string; description?: string };

/** Join catalog metadata by installed identity. A plugin command is never a Skill reference. */
export function catalogSkills<S extends Skill, C extends Command>(skills: S[], commands: C[]) {
  const key = (path: string) => {
    const normalized = path.replaceAll('\\', '/');
    return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const byPath = new Map(skills.map(skill => [key(skill.path), skill]));
  const byName = new Map(skills.map(skill => [skill.name, skill]));
  const entries: { id: string; path?: string; skill?: S; command?: C }[] = [];
  for (const command of commands) {
    if (command.kind !== 'skill') continue;
    const skill = command.path ? byPath.get(key(command.path)) : byName.get(command.id);
    entries.push({id: command.id, path: command.path || skill?.path, skill, command});
    byName.delete(command.id);
    if (skill) byName.delete(skill.name);
  }
  for (const skill of byName.values()) entries.push({id: skill.name, path: skill.path, skill});
  return entries;
}

export function resourceMention(id: string, path?: string) {
  const label = '@' + id.replace(/([\\\[\]])/g, '\\$1');
  return path ? `[${label}](<${path.replaceAll('\\', '/').replaceAll('<', '%3C').replaceAll('>', '%3E')}>)` : label;
}

export type ResourceChoice = { id: string; value: string };

/** Ambiguous short names can only be selected by identity in the picker. */
export function resourceMentionTargets(choices: ResourceChoice[]) {
  const mentions = new Map<string, string | null>();
  for (const { id, value } of choices) {
    for (const name of new Set([id, id.split(':').at(-1)!])) {
      mentions.set(name, mentions.has(name) && mentions.get(name) !== value ? null : value);
    }
  }
  return mentions;
}

export function resolveResourceMentions(text: string, choices: ResourceChoice[]) {
  if (!text.includes('@')) return text;
  const mentions = resourceMentionTargets(choices);
  const pattern = /(^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n|$)[\s\S]*?(?:^[ \t]*\2[`~]*[ \t]*(?:\r?\n|$)|$(?![\s\S])))|(`+)[\s\S]*?\3(?!`)|\[[^\]\r\n]*\]\((?:<[^>\r\n]+>|[^()\r\n]*)\)|(^|\s)@([\w.-]+(?::[\w-]+)?)(?=$|\.(?![\w.:-])|[\s,!?;)，。！？、；（）])/gm;
  return text.replace(pattern, (literal, _fence, _marker, _ticks, space, name: string | undefined) => {
    if (!name) return literal;
    const id = mentions.has(name) ? name : name.replace(/\.+$/, '');
    const target = mentions.get(id);
    return target ? space + target + name.slice(id.length) : literal;
  });
}
