import { z } from 'zod';

export const storageInventorySchema = z.object({
  rows: z.array(z.object({
    category: z.enum(['registeredAgents', 'teamDefinitions', 'teamRuns', 'childRecovery', 'assistantHistory',
      'runtimeHistory', 'attachmentCopies', 'transferredFiles', 'pastedText', 'webUploadStaging', 'webFiles',
      'browserCaches', 'previews', 'interpreters', 'voiceModels', 'voiceHistory', 'webhookRecords', 'diagnosticLogs',
      'usage', 'repairBackups']),
    policy: z.enum(['definition', 'history', 'references', 'cache', 'drafts', 'installed', 'webhook', 'protected']),
    usage: z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).nullable(),
  })),
});

export type StorageInventory = z.infer<typeof storageInventorySchema>;
