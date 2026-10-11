/** Delivery references in prose, excluding fenced and inline code examples. */
export function memoMarkdownLinks(content: string, scheme: 'cardbush-memo' | 'cardbush-source') {
  if (!content.includes(`${scheme}:`)) return [];
  const prose = content.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, match => ' '.repeat(match.length))
    .replace(/(`+)[^`]*?\1/g, match => ' '.repeat(match.length));
  return [...prose.matchAll(/\[((?:\\.|[^\]\\\r\n])*)\]\(\s*<?(cardbush-(?:memo|source):[^\s<>)]*)>?\s*(?:["'][^\r\n]*?["']\s*)?\)|<((?:cardbush-(?:memo|source):)[^\s<>]+)>|^\s*\[[^\]\r\n]+\]:\s*<?(cardbush-(?:memo|source):[^\s<>]+)>?/gm)]
    .map(match => ({ reference: match[2] ?? match[3] ?? match[4]!, label: match[1]?.replace(/\\([\\\[\]])/g, '$1').trim() }))
    .filter(link => link.reference.startsWith(`${scheme}:`));
}
