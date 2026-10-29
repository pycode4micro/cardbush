import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { BrowserConnectorError } from './bridgeClient.js';
import { evaluate, type PageCommand } from './pageCapture.js';
import { inspectElement, readElement, record } from './pageInspection.js';

const uid = z.string().regex(/^cb_\d+$/);
const condition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(2000), present: z.boolean().default(true), uid: uid.optional() }).strict(),
  z.object({ kind: z.literal('value'), uid, value: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal('visible'), uid, value: z.boolean() }).strict(),
  z.object({ kind: z.literal('enabled'), uid, value: z.boolean() }).strict(),
  z.object({ kind: z.literal('state'), uid, name: z.enum(['busy', 'expanded', 'checked', 'selected']), value: z.union([z.boolean(), z.literal('mixed')]) }).strict(),
  z.object({ kind: z.literal('url'), value: z.string().min(1).max(2000), match: z.enum(['equals', 'includes']).default('equals') }).strict(),
]);
export const waitSchema = z.object({ text: z.string().min(1).max(2000).optional(),
  conditions: z.array(condition).min(1).max(10).optional(), timeout: z.number().int().min(100).max(30000).default(10000),
}).strict().refine(input => Boolean(input.text) !== Boolean(input.conditions), 'Pass either text or conditions. All conditions must hold in one polling pass.');

const checkElement = `function(condition) {
  const facts = (${inspectElement}).call(this);
  const element = this.nodeType===3 ? this.parentElement : this;
  let matched = false;
  if (condition.kind==='visible') matched = (facts.connected===true && facts.hasArea===true && !facts.hidden) === condition.value;
  else if (facts.connected) {
    if (condition.kind==='value' && ('value' in element || element.isContentEditable)) matched = String('value' in element ? element.value : element.textContent)===condition.value;
    if (condition.kind==='enabled') matched = (!facts.disabled && !facts.inert)===condition.value;
    if (condition.kind==='state') matched = facts.state[condition.name]===condition.value;
    if (condition.kind==='text') matched = (element.innerText || element.textContent || '').includes(condition.text)===(condition.present!==false);
  }
  return {matched,connected:facts.connected,hasArea:facts.hasArea,hidden:facts.hidden,disabled:facts.disabled,inert:facts.inert,state:facts.state,
    ...(condition.kind==='value' && facts.value!==undefined ? {value:facts.value,valueTruncated:facts.valueTruncated} : {})};
}`;

export async function waitForPage(command: PageCommand, input: z.infer<typeof waitSchema>, signal?: AbortSignal, deadline = Date.now() + input.timeout) {
  const conditions: z.infer<typeof condition>[] = input.conditions ?? [{ kind: 'text', text: input.text!, present: true }];
  const start = Date.now(); const observations: Record<string, unknown>[] = [];
  const timeout = (cause?: BrowserConnectorError) => new BrowserConnectorError('wait_for_timeout', 'The requested page conditions were not observed before the timeout.', {
    conditions, observations, elapsedMs: Date.now() - start,
    ...(cause ? { lastRequestError: { code: cause.code, message: cause.message, details: cause.details } } : {}),
  });
  const checkBudget = () => { signal?.throwIfAborted(); if (Date.now() >= deadline) throw timeout(); };
  const send = command;
  command = async (name, params) => {
    checkBudget();
    try { return await send(name, params); }
    catch (error) {
      signal?.throwIfAborted();
      if (error instanceof BrowserConnectorError && ['bridge_timeout', 'browser_connector_timeout', 'cardbush_browser_timeout'].includes(error.code)) throw timeout(error);
      throw error;
    }
  };
  const targeted = conditions.some(item => 'uid' in item && item.uid);
  const seen = new Set<string>();
  const identity = async () => {
    const root = record(record(await command('Page.getFrameTree')).frameTree);
    const frames = (tree: Record<string, unknown>): unknown[] => {
      const frame = record(tree.frame);
      if (!frame.id || !frame.loaderId) throw new BrowserConnectorError('wait_document_unavailable', 'The document identity is unavailable. Take a fresh snapshot once the page loads.');
      return [[frame.id, frame.loaderId], ...(Array.isArray(tree.childFrames) ? tree.childFrames.flatMap(child => frames(record(child))) : [])];
    };
    return JSON.stringify(frames(root));
  };
  signal?.throwIfAborted();
  const document = targeted ? await identity() : undefined;
  while (true) {
    checkBudget();
    if (targeted && document !== await identity()) throw new BrowserConnectorError('wait_document_changed', 'The document changed; take a fresh snapshot for new uids. No action was retried.');
    for (const [index, item] of conditions.entries()) {
      signal?.throwIfAborted();
      let observation: Record<string, unknown>;
      if ('uid' in item && item.uid) {
        try { observation = await readElement(command, item.uid, checkElement, [item]); seen.add(item.uid); }
        catch (error) {
          if (!(error instanceof Error) || !/No node with given id|Could not find node with given id|element_not_found/.test(error.message + ' ' + ('code' in error ? error.code : ''))) throw error;
          if (!seen.has(item.uid)) throw new BrowserConnectorError('wait_target_missing', `${item.uid} could not be resolved. Its disappearance cannot be confirmed; take a fresh snapshot.`);
          observation = { connected: false, matched: item.kind === 'visible' && item.value === false };
        }
      } else if (item.kind === 'text') {
        const value = await evaluate(command, `(document.body?.innerText || '').includes(${JSON.stringify(item.text)})`);
        observation = { matched: value === (item.present !== false) };
      } else if (item.kind === 'url') {
        const value = String(await evaluate(command, 'location.href'));
        observation = { matched: item.match === 'includes' ? value.includes(item.value) : value === item.value, url: value.slice(0,2000) };
      } else throw new BrowserConnectorError('invalid_wait_condition', 'This condition requires a uid.');
      observations[index] = observation;
    }
    // A navigation between reads must not turn a stale uid into a successful wait.
    if (targeted && document !== await identity()) throw new BrowserConnectorError('wait_document_changed', 'The document changed while checking conditions. Take a fresh snapshot.');
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeout();
    if (observations.every(item => item.matched === true)) return { matched: true, elapsedMs: Date.now() - start, conditions, observations };
    await delay(Math.min(100, remaining), undefined, { signal });
  }
}
