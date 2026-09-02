import fs from 'node:fs';
import path from 'node:path';

export interface ProductSkillSummary {
  name: string;
  description: string;
  descriptionZh: string;
  path: string;
  logoPath: string;
  logoDarkPath: string;
  source: ProductSkillSource;
  sourceId: string;
  sourceLabel: string;
}

export type ProductSkillSource = 'bundled' | 'user' | 'plugin' | 'external';

export interface ProductSkillRoot {
  path: string;
  source: ProductSkillSource;
  sourceId?: string;
  sourceLabel?: string;
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

export interface LegacyProductSkillMigrationResult {
  imported: string[];
  skipped: string[];
  excluded: string[];
  failed: Array<{ name: string; message: string }>;
  alreadyCompleted: boolean;
  markerPath: string;
}

export interface LegacyProductSkillMigrationOptions {
  excludedNames?: Iterable<string>;
}

export const legacyProductSkillMigrationMarker =
  '.legacy-bushserver-skill-migration-v1.json';

/**
 * Imports only catalogued legacy Skill packages that do not already exist in
 * CardBush-owned storage. A persistent completion marker makes the migration
 * one-shot, so removing an imported Skill later cannot make it reappear.
 * Existing Product Skills are never overwritten.
 */
export async function migrateLegacyProductSkills(
  legacyRoots: string[],
  userRoot: string,
  options: LegacyProductSkillMigrationOptions = {},
): Promise<LegacyProductSkillMigrationResult> {
  const targetRoot = path.resolve(userRoot);
  const markerPath = path.join(targetRoot, legacyProductSkillMigrationMarker);
  const result: LegacyProductSkillMigrationResult = {
    imported: [],
    skipped: [],
    excluded: [],
    failed: [],
    alreadyCompleted: false,
    markerPath,
  };
  await fs.promises.mkdir(targetRoot, { recursive: true });
  if (await pathExists(markerPath)) {
    result.alreadyCompleted = true;
    return result;
  }
  const excludedNames = new Set(
    [...(options.excludedNames ?? [])]
      .map((name) => String(name).trim())
      .filter(isSafePackageName),
  );
  const resolvedLegacyRoots = [...new Set(legacyRoots.map((root) => path.resolve(root)))];

  for (const configuredRoot of resolvedLegacyRoots) {
    const legacyRoot = await fs.promises.realpath(configuredRoot).catch(() => null);
    if (!legacyRoot) continue;
    const packageRoot = await fs.promises.realpath(path.join(legacyRoot, 'package')).catch(() => null);
    if (!packageRoot || escapes(legacyRoot, packageRoot)) continue;
    const names = await legacyCatalogSkillNames(path.join(legacyRoot, 'catalog.json'));
    for (const name of names) {
      if (excludedNames.has(name)) {
        result.excluded.push(name);
        continue;
      }
      const target = path.join(targetRoot, name);
      if (await pathExists(target)) {
        result.skipped.push(name);
        continue;
      }
      const source = await fs.promises.realpath(path.join(packageRoot, name)).catch(() => null);
      if (!source || escapes(packageRoot, source) || !await pathExists(path.join(source, 'SKILL.md'))) {
        result.failed.push({ name, message: 'Catalogued Skill package is missing or unsafe.' });
        continue;
      }
      const temporary = path.join(
        targetRoot,
        `.${name}.legacy-migration-${process.pid}-${Date.now()}`,
      );
      try {
        await fs.promises.cp(source, temporary, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        await fs.promises.rename(temporary, target);
        result.imported.push(name);
      } catch (error) {
        await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        if (await pathExists(target)) {
          result.skipped.push(name);
          continue;
        }
        result.failed.push({
          name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  await persistLegacyMigrationMarker(markerPath, {
    protocol: 'cardbush.legacy_skill_migration.v1',
    completedAt: new Date().toISOString(),
    legacyRoots: resolvedLegacyRoots,
    imported: [...new Set(result.imported)],
    skipped: [...new Set(result.skipped)],
    excluded: [...new Set(result.excluded)],
    failed: result.failed,
  });
  return result;
}

export async function listProductSkills(
  roots: Array<string | ProductSkillRoot>,
): Promise<ProductSkillSummary[]> {
  const skills = await loadProductSkills(roots);
  return [...skills.values()]
    .map(({ content: _content, packageDir: _packageDir, ...summary }) => summary)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function readProductSkill(
  roots: Array<string | ProductSkillRoot>,
  requestedName: string,
): Promise<ProductSkillDetail> {
  const name = requestedName.trim();
  if (!name) throw new Error('Skill name is empty.');
  const skill = (await loadProductSkills(roots)).get(name);
  if (!skill) throw new Error(`Skill ${name} is not installed.`);
  return skill;
}

async function loadProductSkills(
  roots: Array<string | ProductSkillRoot>,
): Promise<Map<string, ProductSkillDetail>> {
  const skills = new Map<string, ProductSkillDetail>();
  for (const configuredRoot of roots.map(normalizeProductSkillRoot)) {
    const root = path.resolve(configuredRoot.path);
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
      const logoPath = await resolveSkillLogo(packageDir, metadata.logo ?? metadata.icon);
      const logoDarkPath = await resolveSkillLogo(
        packageDir,
        metadata.logo_dark ?? metadata.icon_dark,
        true,
      );
      skills.set(name, {
        name,
        description: stringValue(metadata.description),
        descriptionZh: stringValue(metadata.description_zh),
        path: skillPath,
        logoPath,
        logoDarkPath,
        source: configuredRoot.source,
        sourceId: configuredRoot.sourceId,
        sourceLabel: configuredRoot.sourceLabel,
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

function normalizeProductSkillRoot(root: string | ProductSkillRoot): Required<ProductSkillRoot> {
  if (typeof root === 'string') {
    return {
      path: root,
      source: 'external',
      sourceId: '',
      sourceLabel: '',
    };
  }
  return {
    path: root.path,
    source: root.source,
    sourceId: root.sourceId?.trim() ?? '',
    sourceLabel: root.sourceLabel?.trim() ?? '',
  };
}

const skillLogoNames = [
  'assets/logo.svg',
  'assets/logo.png',
  'assets/logo.webp',
  'assets/icon.svg',
  'assets/icon.png',
  'assets/icon.webp',
  'logo.svg',
  'logo.png',
  'logo.webp',
  'icon.svg',
  'icon.png',
  'icon.webp',
];

async function resolveSkillLogo(
  packageDir: string,
  declared: unknown,
  dark = false,
): Promise<string> {
  const explicit = stringValue(declared).trim();
  const conventional = dark
    ? skillLogoNames.map((name) => name.replace(/\.(svg|png|webp)$/i, '-dark.$1'))
    : skillLogoNames;
  for (const relativeLogo of [...(explicit ? [explicit] : []), ...conventional]) {
    if (path.isAbsolute(relativeLogo)) continue;
    const candidate = path.resolve(packageDir, relativeLogo);
    if (escapes(packageDir, candidate)) continue;
    const realPath = await fs.promises.realpath(candidate).catch(() => null);
    if (!realPath || escapes(packageDir, realPath)) continue;
    const file = await fs.promises.stat(realPath).catch(() => null);
    if (file?.isFile() && /\.(?:svg|png|webp|jpe?g)$/i.test(realPath)) return realPath;
  }
  return '';
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

async function legacyCatalogSkillNames(catalogPath: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(catalogPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const skills = (parsed as Record<string, unknown>).skills;
    if (!Array.isArray(skills)) return [];
    return [...new Set(skills.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const name = stringValue((entry as Record<string, unknown>).name).trim();
      return isSafePackageName(name) ? [name] : [];
    }))];
  } catch {
    return [];
  }
}

async function persistLegacyMigrationMarker(
  markerPath: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const temporary = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.promises.rename(temporary, markerPath);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    if (await pathExists(markerPath)) return;
    throw error;
  }
}

function isSafePackageName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== '.' && name !== '..';
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.promises.stat(candidate).then(() => true, () => false);
}
