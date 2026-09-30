import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { browserTranslationScript } from './browserTranslationPage.js';
import type { BrowserTranslationRequest, BrowserTranslationResult, TranslationLanguage, TranslationText } from './browserTranslationTypes.js';

type Translator = (texts: TranslationText[], language: TranslationLanguage, jobId: string, signal: AbortSignal) => Promise<TranslationText[]>;
const world = 1047;

export class BrowserTranslationService {
  private readonly jobs = new Map<number, AbortController>();
  constructor(private readonly getGuest: (id: number) => WebContents | undefined, private readonly translate: Translator) {}

  async run(ownerId: number, input: BrowserTranslationRequest): Promise<BrowserTranslationResult> {
    if (!Number.isSafeInteger(input?.guestWebContentsId) || input.guestWebContentsId <= 0) return { status: 'error', error: 'unavailable' };
    const guest = this.getGuest(input?.guestWebContentsId);
    if (!guest || guest.isDestroyed() || guest.hostWebContents?.id !== ownerId
      || !['translate', 'restore'].includes(input?.action) || !['zh', 'en'].includes(input?.language)) {
      return { status: 'error', error: 'unavailable' };
    }
    const execute = (command: Parameters<typeof browserTranslationScript>[0]) =>
      guest.executeJavaScriptInIsolatedWorld(world, [{ code: browserTranslationScript(command) }]);
    this.jobs.get(guest.id)?.abort();
    this.jobs.delete(guest.id);
    if (input.action === 'restore') {
      await execute({ action: 'restore' }).catch(() => undefined);
      return { status: 'original' };
    }
    if (!/^https?:\/\//i.test(guest.getURL()) || guest.isLoadingMainFrame()) return { status: 'error', error: 'unavailable' };
    const controller = new AbortController(), jobId = randomUUID(), signal = controller.signal;
    this.jobs.set(guest.id, controller);
    const url = guest.getURL().split('#')[0];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180_000);
    timer.unref?.();
    const stop = () => controller.abort();
    const navigating = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && (!inPlace || _url.split('#')[0] !== url)) stop();
    };
    guest.on('did-start-navigation', navigating);
    guest.once('destroyed', stop);
    guest.once('render-process-gone', stop);
    const owner = guest.hostWebContents;
    owner?.once('destroyed', stop);
    const check = () => {
      signal.throwIfAborted();
      if (guest.isDestroyed() || guest.getURL().split('#')[0] !== url) throw new Error('Page changed.');
    };
    try {
      const snapshot = await execute({ action: 'collect', jobId }) as { texts: TranslationText[]; partial: boolean };
      check();
      if (!snapshot.texts.length) throw new Error('translation_no_text');
      // Deduplicate repeated navigation labels without losing their node identities.
      const aliases = new Map<string, TranslationText[]>();
      for (const text of snapshot.texts) aliases.set(text.text, [...(aliases.get(text.text) ?? []), text]);
      const unique = [...aliases.values()].map(items => items[0]);
      let translated = 0;
      for (let offset = 0; offset < unique.length;) {
        const batch: TranslationText[] = [];
        let size = 0;
        while (offset < unique.length && batch.length < 80 && size + unique[offset].text.length <= 6000) {
          const item = unique[offset++]; batch.push(item); size += item.text.length;
        }
        check();
        const result = await this.translate(batch, input.language, jobId, signal);
        check();
        if (result.length !== batch.length || new Set(result.map(item => item.id)).size !== batch.length
          || result.some(item => !batch.some(source => source.id === item.id) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 24_000)) {
          throw new Error('Invalid translation result.');
        }
        const texts = result.flatMap(item => aliases.get(batch.find(source => source.id === item.id)!.text)!.map(source => ({ id: source.id, text: item.text })));
        translated += (await execute({ action: 'apply', jobId, texts }) as { count: number }).count;
      }
      check();
      if (!translated) throw new Error('translation_no_text');
      return { status: 'translated', language: input.language, partial: snapshot.partial || translated < snapshot.texts.length };
    } catch (error) {
      if (!guest.isDestroyed()) await execute({ action: 'restore', jobId }).catch(() => undefined);
      if (signal.aborted && !timedOut) return { status: 'original' };
      return { status: 'error', error: timedOut ? 'timeout' : error instanceof Error && error.message === 'translation_model_unavailable' ? 'model'
        : error instanceof Error && error.message === 'translation_no_text' ? 'no_text' : 'failed' };
    } finally {
      clearTimeout(timer);
      guest.removeListener('did-start-navigation', navigating);
      guest.removeListener('destroyed', stop);
      guest.removeListener('render-process-gone', stop);
      owner?.removeListener('destroyed', stop);
      if (this.jobs.get(guest.id) === controller) this.jobs.delete(guest.id);
    }
  }
}
