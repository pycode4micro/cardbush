import type { RuntimeUserPrompt } from '@cardbush/bush-protocol';

export interface WelcomeSuggestion {
  text: string;
  topic: string;
  fromHistory: boolean;
}

const stopWords = new Set(`的 了 是 在 和 与 或 有 把 对 给 用 为 到 从 中 内 上 下 这个 那个 这些 那些 这里 那里 这样 那样 一个 一下 一些 什么 怎么 为什么 如何 是否 能不能 可以 可能 需要 应该 已经 现在 目前 还是 还有 但是 因为 所以 然后 如果 就是 不是 不要 不用 不能 没有 没什么 不会 不太 先 再 都 也 很 更 最 我 我们 你 你们 他 它 自己 用户 请 帮 帮我 谢谢 看看 看下 帮忙 继续 完成 执行 修改 优化 支持 问题 功能 内容 使用 设置 增加 实现 进行 通过 根据 一直 直接 具体 相关 进行 最后 the a an and or but for with from to of in on at by is are was were be been being it its this that these those i me my we our you your he she they their please can could would should will do does did have has had not no yes so if then than as how what why when where which help make use using used want need let's let also just about into more some any all now already thanks must really don't doesn't`.split(/\s+/));

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
for (const word of ['检查', '分析', '参考', '调整', '生成', '改进', '处理', '保留', '整理', '重新', '确认', '排查', '梳理']) stopWords.add(word);
const hanStops = [...stopWords].filter(word => /^\p{Script=Han}+$/u.test(word)).sort((a, b) => b.length - a.length);
const key = (value: string) => value.normalize('NFKC').toLowerCase();

/** Only prose participates. Attached sources, code, URLs and explicit references
 * are not evidence of what the user repeatedly asks for. */
export function welcomePromptProse(content: string) {
  const requestMarker = content.lastIndexOf('## My request:');
  if (requestMarker >= 0) content = content.slice(requestMarker + '## My request:'.length);
  return content
    .replace(/<([\w-]+)\b[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/(?:```|~~~)[\s\S]*?(?:(?:```|~~~)|$)/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/!?\[[^\]]*\]\(cardbush-reference:[^\n]*?\)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+|(?:[A-Za-z]:[\\/]|\\\\)\S+/g, ' ')
    .replace(/\b(?:local-[\da-f-]{20,}|[\da-f]{24,}|[\w-]{40,})\b/gi, ' ')
    .replace(/[*_`#]/g, '')
    .replace(/^[\s\d.、-]+/gm, '')
    .trim();
}

export function welcomeTerms(content: string) {
  const parts = Array.from(segmenter.segment(content));
  const terms = parts.flatMap(part => {
    const term = key(part.segment);
    return part.isWordLike && term.length >= 2 && term.length <= 28 && /\p{L}/u.test(term) && !stopWords.has(term) ? [term] : [];
  });
  // ICU sometimes splits Chinese technical words (e.g. 缓存) into single
  // characters. Recover adjacent unknown characters without a domain lexicon.
  for (let index = 0; index < parts.length; index++) {
    if (!/^\p{Script=Han}$/u.test(parts[index].segment)) continue;
    let run = parts[index].segment;
    while (index + 1 < parts.length && /^\p{Script=Han}$/u.test(parts[index + 1].segment)) run += parts[++index].segment;
    for (const stop of hanStops) run = run.split(stop).join(' ');
    for (const fragment of run.split(/\s+/)) {
      if (fragment.length >= 2 && fragment.length <= 4) terms.push(fragment);
      else if (fragment.length > 4) for (let start = 0; start < fragment.length - 1; start++) terms.push(fragment.slice(start, start + 2));
    }
  }
  return [...new Set(terms)];
}

function similarity(left: string[], right: string[]) {
  const common = left.filter(term => right.includes(term)).length;
  return common / Math.max(1, Math.min(left.length, right.length));
}

const starters = {
  zh: [
    ['想法', '帮我梳理一个想法，整理成可执行的步骤。'],
    ['探索', '陪我研究一个感兴趣的话题，从关键问题开始。'],
    ['创作', '和我一起打磨一段内容，让表达更清楚。'],
  ],
  en: [
    ['Ideas', 'Help me turn an idea into a clear, practical plan.'],
    ['Explore', 'Explore a topic with me, starting with the key questions.'],
    ['Create', 'Help me refine a piece of writing and make it clearer.'],
  ],
};

/** Extractive ranking: frequency across authored prompts, then diverse, complete
 * sentences from those prompts. No model call or mutation of model context. */
export function buildWelcomeSuggestions(history: RuntimeUserPrompt[], language: 'zh' | 'en', now = Date.now()): WelcomeSuggestion[] {
  const since = now - 7 * 86400000;
  const unique = new Map<string, { prose: string; terms: string[]; time: number; truncated: boolean }>();
  for (const row of [...history].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    const time = Date.parse(row.createdAt);
    if (!Number.isFinite(time) || time < since || time > now) continue;
    const prose = welcomePromptProse(row.content);
    const identity = `${row.sessionId}:${key(prose).replace(/\s/g, '')}`;
    if (!prose || unique.has(identity)) continue; // Retries/pastes in one conversation do not inflate frequency.
    unique.set(identity, { prose, terms: welcomeTerms(prose), time, truncated: row.truncated });
  }
  const frequencies = new Map<string, number>();
  for (const row of unique.values()) for (const term of row.terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);

  const candidates: { text: string; terms: string[]; score: number }[] = [];
  const texts = new Set<string>();
  for (const row of unique.values()) {
    const sentences = row.prose.split(/\n+/).flatMap(line => Array.from(sentenceSegmenter.segment(line), part => part.segment));
    for (let index = 0; index < sentences.length; index++) {
      const text = sentences[index].replace(/\s+/g, ' ').trim();
      // Keep complete useful sentences, rather than cut off instructions or
      // promote structured payloads / credential assignments into a home tile.
      if (text.length < 9 || text.length > 150 || (row.truncated && index === sentences.length - 1) ||
        /[{}]|(?:password|secret|token|api[_ -]?key|密码|密钥)\s*[:=]/i.test(text)) continue;
      const terms = welcomeTerms(text);
      const identity = key(text).replace(/[\s\p{P}]/gu, '');
      if (terms.length < 2 || texts.has(identity)) continue;
      texts.add(identity);
      const frequency = terms.map(term => frequencies.get(term) ?? 0).sort((a, b) => b - a);
      const score = frequency.slice(0, 3).reduce((sum, count) => sum + count, 0) / Math.sqrt(Math.max(2, terms.length)) +
        0.4 * (row.time - since) / (now - since);
      candidates.push({ text, terms, score });
    }
  }
  const chosen: typeof candidates = [];
  const usedTopics = new Set<string>();
  const suggestions: WelcomeSuggestion[] = [];
  while (candidates.length && suggestions.length < 3) {
    const score = (candidate: typeof candidates[number]) => candidate.score *
      (1 - 0.85 * Math.max(0, ...chosen.map(other => similarity(candidate.terms, other.terms))));
    candidates.sort((a, b) => score(b) - score(a) || a.text.localeCompare(b.text));
    const candidate = candidates.shift()!;
    if (chosen.some(other => similarity(candidate.terms, other.terms) >= 0.8)) continue;
    chosen.push(candidate);
    const rankedTerms = [...candidate.terms].sort((a, b) => (frequencies.get(b) ?? 0) - (frequencies.get(a) ?? 0));
    const topic = rankedTerms.find(term => !usedTopics.has(term)) ?? rankedTerms[0];
    usedTopics.add(topic);
    suggestions.push({ text: candidate.text, topic, fromHistory: true });
  }
  for (const [topic, text] of starters[language]) {
    if (suggestions.length === 3) break;
    suggestions.push({ text, topic, fromHistory: false });
  }
  return suggestions;
}
