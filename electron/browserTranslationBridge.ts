import { randomUUID } from 'node:crypto';
import type { TranslationLanguage, TranslationText } from './browserTranslationTypes.js';

type Services = {
  product: { execute: (command: unknown) => Promise<unknown> };
  runtime: { command: (command: unknown) => Promise<unknown>; cancelOperation: (command: unknown) => Promise<void> };
};
type ResolvedModel = { model: string; binding: unknown; reasoningEffort?: string; maxOutputTokens?: number };

/** Pin one default model/binding for a whole page; secrets remain in the existing host registry. */
export function createBrowserTranslator(services: () => Promise<Services>) {
  const preparations = new WeakMap<AbortSignal, Promise<{ selected: ResolvedModel; runtime: Services['runtime'] }>>();
  const prepare = async (signal: AbortSignal) => {
    const { product, runtime } = await services();
    signal.throwIfAborted();
    const configuration = await product.execute({ protocol: 'cardbush.product_host_ipc.v1', kind: 'models.get' }) as {
      ok: boolean; value?: { defaultModelId?: string; models?: Array<{ id: string }> };
    };
    const modelId = configuration.value?.defaultModelId || configuration.value?.models?.[0]?.id;
    if (!configuration.ok || !modelId) throw new Error('translation_model_unavailable');
    signal.throwIfAborted();
    const resolution = await product.execute({ protocol: 'cardbush.product_host_ipc.v1', kind: 'model.resolve', modelId }) as {
      ok: boolean; value?: ResolvedModel;
    };
    if (!resolution.ok || !resolution.value) throw new Error('translation_model_unavailable');
    signal.throwIfAborted();
    return { selected: resolution.value, runtime };
  };
  return async (texts: TranslationText[], language: TranslationLanguage, jobId: string, signal: AbortSignal): Promise<TranslationText[]> => {
    signal.throwIfAborted();
    let preparation = preparations.get(signal);
    if (!preparation) { preparation = prepare(signal); preparations.set(signal, preparation); }
    const { selected, runtime } = await preparation, operationId = randomUUID();
    signal.throwIfAborted();
    const cancel = () => { void runtime.cancelOperation({ protocol: 'bush.runtime_ipc.v1', type: 'cancel_operation', operationId }).catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const response = await runtime.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId,
        command: { kind: 'runtime.browser_translate', payload: { texts, language, jobId,
          model: { model: selected.model, providerBinding: selected.binding, reasoningEffort: selected.reasoningEffort, maxOutputTokens: selected.maxOutputTokens } } },
      }) as { ok?: boolean; result?: TranslationText[] };
      signal.throwIfAborted();
      if (!response.ok || !response.result) throw new Error('Translation request failed.');
      return response.result;
    } finally { signal.removeEventListener('abort', cancel); }
  };
}
