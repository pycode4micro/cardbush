import { createHash } from 'node:crypto';

export const normalizedMemory = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, ' ').trim();
export const memoryHash = (text: string) => createHash('sha256').update(normalizedMemory(text)).digest('hex').slice(0, 24);
/** Explicitly an estimate: count CJK more conservatively than Latin prose. */
export function memoryTokens(text: string): number {
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  return Math.ceil(cjk * 1.5 + (text.length - cjk) / 3.5);
}
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stop = new Set(['the','and','for','this','that','with','please','用户','需要','现在','这个','那个','一下','可以','帮我','然后','继续','什么']);
export function memoryTerms(text: string): string[] {
  const normalized = normalizedMemory(text.slice(0,4000));
  const words = [...segmenter.segment(normalized)].filter(s => s.isWordLike).map(s => s.segment).filter(s => s.length > 1 && !stop.has(s));
  for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) for (let i=0; i<run.length-1; i++) words.push(run.slice(i,i+2));
  const joined=normalized.replace(/(?<=\p{Script=Han})\s+(?=[a-z0-9])/gu,'').replace(/(?<=[a-z0-9])\s+(?=\p{Script=Han})/gu,'');
  words.push(...joined.match(/[\p{Script=Han}][a-z0-9]+|[a-z0-9]+[\p{Script=Han}]/gu)??[]);
  return [...new Set(words.filter(word=>!stop.has(word)))].slice(0, 96);
}
export function boundedMemoryText(text: string, budget: number): string {
  const originalLength=text.length;
  text=text.slice(0,Math.max(0,budget*4));
  if (originalLength===text.length && memoryTokens(text) <= budget) return text;
  let low=0, high=text.length;
  while (low<high) { const mid=Math.ceil((low+high)/2); if(memoryTokens(text.slice(0,mid))<=budget-1) low=mid; else high=mid-1; }
  return text.slice(0,low)+'…';
}
