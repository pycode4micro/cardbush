import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pluginRuntimeRoot } from '@cardbush/platform';
import type { StorageInventory } from '@cardbush/bush-protocol';

export interface StorageInventoryRoot {
  path: string;
  desktop: boolean;
  sessionData?: string;
  webUploads?: boolean;
}

type Row = StorageInventory['rows'][number];
type Usage = NonNullable<Row['usage']>;
type Store = [Row['category'], Row['policy'], string[]];

async function measure(path: string): Promise<Usage> {
  const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info || info.isSymbolicLink()) return { files: 0, bytes: 0 };
  if (info.isFile()) return { files: 1, bytes: info.size };
  const total = { files: 0, bytes: 0 };
  if (info.isDirectory()) for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const child = await measure(join(path, entry.name));
    total.files += child.files;
    total.bytes += child.bytes;
  }
  return total;
}

export async function storageInventory(runtime: string, host: StorageInventoryRoot, logRoots: string[]): Promise<StorageInventory> {
  const disk = (...paths: string[]) => paths.map(path => join(host.path, path));
  const state = (...paths: string[]) => paths.map(path => join(runtime, path));
  const stores: Store[] = [
    ['registeredAgents', 'definition', state('registered-agents')],
    ['teamDefinitions', 'definition', state('teams/definitions')],
    ['teamRuns', 'history', state('teams/runs')],
    ['childRecovery', 'references', state('subagent-context', 'checkpoints')],
    ['assistantHistory', 'history', state('conversation-journal')],
    ['runtimeHistory', 'history', state('events', 'sessions', 'subagents', 'tool-executions', 'coordination')],
    ['attachmentCopies', 'references', state('attachments', 'model-images', 'captures')],
    ['previews', 'cache', disk('plugin-marketplaces')],
    ['interpreters', 'installed', [pluginRuntimeRoot()]],
    ['webhookRecords', 'webhook', disk('webhooks/state.json')],
    ['diagnosticLogs', 'cache', logRoots],
    ['usage', 'protected', disk('usage')],
  ];
  if (host.desktop) {
    const browserRoot = host.sessionData ?? host.path;
    const partitions = join(browserRoot, 'Partitions');
    const info = await lstat(partitions).catch(() => undefined);
    const partitionNames = info?.isDirectory() && !info.isSymbolicLink()
      ? (await readdir(partitions, { withFileTypes: true }).catch(() => []))
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => join(partitions, entry.name)) : [];
    stores.push(
      ['browserCaches', 'cache', [browserRoot, ...partitionNames].flatMap(path =>
        ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Service Worker/CacheStorage'].map(name => join(path, name)))],
      ['transferredFiles', 'protected', disk('transferred-attachments')],
      ['pastedText', 'drafts', disk('attachments/pasted-text')],
      ['voiceModels', 'installed', disk('voice-models')],
      ['voiceHistory', 'history', disk('voice-history')],
      ['repairBackups', 'protected', disk('repair-backups')],
    );
  }
  if (host.webUploads) stores.push(
    ['webUploadStaging', 'cache', disk('upload-staging')],
    ['webFiles', 'protected', disk('workspaces/uploads')],
  );
  const rows = await Promise.all(stores.map(async ([category, policy, paths]): Promise<Row> => {
    let usage: Row['usage'] = { files: 0, bytes: 0 };
    try {
      for (const path of new Set(paths)) {
        const entry = await measure(path);
        usage.files += entry.files;
        usage.bytes += entry.bytes;
      }
    } catch { usage = null; }
    return { category, policy, usage };
  }));
  return { rows };
}
