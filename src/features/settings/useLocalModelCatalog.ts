import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchModelConfigs, isProductHostCommandError, saveModelConfigs, type BackendModelConfigsResult } from '../../backend/api';
import { enqueueLocalModelWrite } from '../../backend/modelConfigWrites';
import { uiText } from '../../i18n';
import { showUiError } from '../../shared/showUiError';
import type { AppSettingsState, ManagedModelConfig } from '../../types';
import { persistAppSettings } from './appSettingsStore';
import {
  defaultModelConfigId,
  effectiveModels,
  mergeLegacyModelCredentials,
  modelConfigSignature,
  normalizeManagedModelConfigs,
  readManagedModelConfigs,
} from './modelPreferences';

type UpdateSettings = (update: (current: AppSettingsState) => AppSettingsState) => void;
type ModelWrite = { signature: string };
type Snapshot = Pick<BackendModelConfigsResult, 'models' | 'defaultModelId' | 'revision'>;
const revisionConflict = 'model_config_revision_conflict';

function catalogue(snapshot: Snapshot) {
  const models = normalizeManagedModelConfigs(snapshot.models);
  const defaultModelId = defaultModelConfigId(models, snapshot.defaultModelId);
  return { models, defaultModelId, revision: snapshot.revision, signature: modelConfigSignature(models, defaultModelId) };
}

export function useLocalModelCatalog(models: ManagedModelConfig[], updateSettings: UpdateSettings) {
  const [ready, setReady] = useState(false);
  const [defaultModelId, setDefaultModelId] = useState(() => window.localStorage.getItem('cardbush.selected_model') ?? '');
  const initial = useRef({ models, defaultModelId });
  const requested = useRef<ModelWrite | null>(null);
  const confirmed = useRef<ReturnType<typeof catalogue> | null>(null);
  const generation = useRef(0);
  const recoveryRequired = useRef(false);
  const availableModels = useMemo(() => effectiveModels(models), [models]);

  const replaceCatalogue = useCallback((saved: ReturnType<typeof catalogue>) => {
    requested.current = confirmed.current = saved;
    setDefaultModelId(saved.defaultModelId);
    updateSettings(current => {
      const next = { ...current, managedModelConfigs: saved.models };
      persistAppSettings(next);
      return next;
    });
  }, [updateSettings]);

  useEffect(() => {
    let disposed = false;
    const initialModels = initial.current;
    const initialDefault = defaultModelConfigId(initialModels.models, initialModels.defaultModelId);
    const signature = modelConfigSignature(initialModels.models, initialDefault);
    const legacy = normalizeManagedModelConfigs(readManagedModelConfigs());
    async function hydrate() {
      try {
        let snapshot = await fetchModelConfigs();
        if (disposed) return;
        try {
          if (!snapshot.models.length && legacy.length) {
            snapshot = await enqueueLocalModelWrite(() => disposed ? Promise.resolve(snapshot) :
              saveModelConfigs({ defaultModelId: defaultModelConfigId(legacy, initialModels.defaultModelId), models: legacy, expectedRevision: snapshot.revision }));
          } else if (snapshot.models.length) {
            const migrated = mergeLegacyModelCredentials(normalizeManagedModelConfigs(snapshot.models), legacy);
            if (migrated.changed) snapshot = await enqueueLocalModelWrite(() => disposed ? Promise.resolve(snapshot) :
              saveModelConfigs({ defaultModelId: snapshot.defaultModelId, models: migrated.models, expectedRevision: snapshot.revision }));
          }
        } catch (error) {
          if (!isProductHostCommandError(error, revisionConflict)) throw error;
          snapshot = await fetchModelConfigs();
        }
        if (disposed) return;
        const saved = catalogue(snapshot);
        requested.current = confirmed.current = saved;
        updateSettings(current => {
          if (modelConfigSignature(current.managedModelConfigs, initialDefault) !== signature) return current;
          const next = { ...current, managedModelConfigs: saved.models };
          persistAppSettings(next);
          return next;
        });
        setDefaultModelId(current => current === initialModels.defaultModelId ? saved.defaultModelId : current);
      } catch {
        // A failed read does not authorize writing the cached catalogue to the host.
        if (!disposed) requested.current = { signature };
      } finally {
        if (!disposed) setReady(true);
      }
    }
    void hydrate();
    return () => {
      disposed = true;
      generation.current++;
      confirmed.current = null;
      requested.current = null;
    };
  }, [updateSettings]);

  useEffect(() => {
    if (!ready) return;
    const selected = defaultModelConfigId(models, defaultModelId);
    const attempt = { signature: modelConfigSignature(models, selected) };
    if (requested.current?.signature === attempt.signature) return;
    requested.current = attempt;
    const scheduled = generation.current;
    void enqueueLocalModelWrite(async () => {
      if (scheduled !== generation.current) return;
      async function reloadAfterConflict(latest?: ReturnType<typeof catalogue>) {
        const recovery = ++generation.current;
        recoveryRequired.current = true;
        confirmed.current = null;
        let reloaded = false;
        try {
          const saved = latest ?? catalogue(await fetchModelConfigs());
          if (generation.current === recovery) {
            replaceCatalogue(saved);
            recoveryRequired.current = false;
            reloaded = true;
          }
        } catch {
          // The next edit must re-read the host and compare the saved baseline again.
          if (generation.current === recovery) requested.current = null;
        } finally {
          if (generation.current === recovery) {
            // Effects queued while fetching still contain the pre-conflict draft.
            generation.current++;
            const t = uiText();
            void showUiError(t('modelCatalog.conflictTitle'), t(reloaded ? 'modelCatalog.conflictReloaded' : 'modelCatalog.conflictUnavailable'));
          }
        }
      }
      try {
        if (!confirmed.current) {
          const latest = catalogue(await fetchModelConfigs());
          if (scheduled !== generation.current) return;
          const original = catalogue(initial.current);
          if (recoveryRequired.current || latest.signature !== original.signature) {
            await reloadAfterConflict(latest);
            return;
          }
          confirmed.current = latest;
        }
        const saved = catalogue(await saveModelConfigs({ models, defaultModelId: selected, expectedRevision: confirmed.current.revision }));
        if (scheduled !== generation.current) return;
        confirmed.current = saved;
        if (requested.current !== attempt) return;
        requested.current = saved;
        setDefaultModelId(current => current === defaultModelId ? saved.defaultModelId : current);
        updateSettings(current => {
          if (modelConfigSignature(current.managedModelConfigs, selected) !== attempt.signature) return current;
          const next = { ...current, managedModelConfigs: saved.models };
          persistAppSettings(next);
          return next;
        });
      } catch (error) {
        if (scheduled !== generation.current) return;
        if (isProductHostCommandError(error, revisionConflict)) await reloadAfterConflict();
        else if (requested.current === attempt) requested.current = null;
      }
    });
  }, [ready, models, defaultModelId, updateSettings, replaceCatalogue]);

  useEffect(() => {
    function reflectReasoning(event: Event) {
      const { connectionId, catalogue: updated } = (event as CustomEvent<{ connectionId: string; catalogue?: Snapshot }>).detail;
      if (!connectionId && updated && confirmed.current && confirmed.current === requested.current) {
        replaceCatalogue(catalogue(updated));
      }
    }
    window.addEventListener('cardbush:model-reasoning-updated', reflectReasoning);
    return () => window.removeEventListener('cardbush:model-reasoning-updated', reflectReasoning);
  }, [replaceCatalogue]);

  return { ready, availableModels, defaultModelId, setDefaultModelId };
}
