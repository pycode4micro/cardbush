import fs from 'node:fs';
import path from 'node:path';

export interface ProductSkillSummary {
  name: string;
  description: string;
  descriptionZh: string;
  path: string;
}

export interface ProductSkillDetail extends ProductSkillSummary {
  packageDir: string;
  content: string;
  version?: string;
  routingHidden: boolean;
  requires: string[];
  conflictsWith: string[];
  minServerVersion?: string;
  timeout?: Record<string, number>;
  companionTools: string[];
  blockedTools: string[];
  requiredReads: string[];
  conditionalReads: string[];
  resourceQuickRefs: Array<Record<string, unknown>>;
}

export async function listProductSkills(roots: string[]): Promise<ProductSkillSummary[]> {
  const skills = await loadProductSkills(roots);
  return [...skills.values()]
    .map(({ content: _content, packageDir: _packageDir, ...summary }) => summary)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function readProductSkill(
  roots: string[],
  requestedName: string,
): Promise<ProductSkillDetail> {
  const name = requestedName.trim();
  if (!name) throw new Error('Skill name is empty.');
  const skill = (await loadProductSkills(roots)).get(name);
  if (!skill) throw new Error(`Skill ${name} is not installed.`);
  return skill;
}

async function loadProductSkills(roots: string[]): Promise<Map<string, ProductSkillDetail>> {
  const skills = new Map<string, ProductSkillDetail>();
  for (const configuredRoot of roots) {
    const root = path.resolve(configuredRoot);
    const rootRealPath = await fs.promises.realpath(root).catch(() => null);
    if (!rootRealPath) continue;
    const entries = await fs.promises.readdir(rootRealPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidateDir = path.join(rootRealPath, entry.name);
      const packageDir = await fs.promises.realpath(candidateDir).catch(() => null);
      if (!packageDir || escapes(rootRealPath, packageDir)) continue;
      const skillPath = path.join(packageDir, 'SKILL.md');
      const content = await fs.promises.readFile(skillPath, 'utf8').catch(() => null);
      if (content == null) continue;
      const metadata = parseFrontmatter(content);
      const name = stringValue(metadata.name) || entry.name;
      skills.set(name, {
        name,
        description: stringValue(metadata.description),
        descriptionZh: stringValue(metadata.description_zh),
        path: skillPath,
        packageDir,
        content,
        version: optionalString(metadata.version),
        routingHidden: metadata.routing_hidden === true,
        requires: stringArray(metadata.requires),
        conflictsWith: stringArray(metadata.conflicts_with),
        minServerVersion: optionalString(metadata.min_server_version),
        timeout: numberRecord(metadata.timeout),
        companionTools: stringArray(metadata.companion_tools),
        blockedTools: stringArray(metadata.blocked_tools),
        requiredReads: stringArray(metadata.required_reads),
        conditionalReads: stringArray(metadata.conditional_reads),
        resourceQuickRefs: recordArray(metadata.resource_quick_refs),
      });
    }
  }
  return skills;
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return {};
  const end = normalized.search(/\r?\n---(?:\r?\n|$)/);
  if (end < 0) return {};
  const lines = normalized.slice(3, end).split(/\r?\n/);
  const result: Record<string, unknown> = {};
  let activeList = '';
  for (const line of lines) {
    const topLevel = line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/);
    if (topLevel) {
      activeList = topLevel[1];
      const raw = (topLevel[2] ?? '').trim();
      result[activeList] = raw ? scalar(raw) : [];
      continue;
    }
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (!listItem || !activeList) continue;
    const values = Array.isArray(result[activeList]) ? result[activeList] as unknown[] : [];
    const mapping = listItem[1].match(/^([^:]+):\s*(.*)$/);
    values.push(mapping
      ? { [mapping[1].trim()]: scalar(mapping[2].trim()) }
      : scalar(listItem[1].trim()));
    result[activeList] = values;
  }
  return result;
}

function scalar(value: string): unknown {
  const unquoted = ((value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")))
    ? value.slice(1, -1).replace(/\\"/g, '"')
    : value;
  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) return Number(unquoted);
  if (unquoted.startsWith('[') && unquoted.endsWith(']')) {
    return unquoted.slice(1, -1).split(',').map((item) => stringValue(scalar(item.trim()))).filter(Boolean);
  }
  return unquoted;
}

function escapes(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath.startsWith('..') || path.isAbsolute(relativePath);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
  const normalized = stringValue(value).trim();
  return normalized || undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).map((item) => item.trim()).filter(Boolean)
    : [];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      item != null && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
