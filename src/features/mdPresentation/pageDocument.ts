import type { MdDocument } from './markdownGraph';

/** The page title stays a normal Markdown heading when exported. */
export function pageTitle(document: MdDocument) {
  const heading = /^# ([^\n]*)(?:\n|$)/.exec(document.introduction);
  return { title: String(document.attributes.name || heading?.[1] || ''),
    body: heading ? document.introduction.slice(heading[0].length).replace(/^\n+/, '') : document.introduction };
}

export function changePageTitle(document: MdDocument, title: string): MdDocument {
  const body = pageTitle(document).body;
  return { ...document, attributes: { ...document.attributes, name: title }, introduction: [title ? `# ${title}` : '', body].filter(Boolean).join('\n\n') };
}

export function changePageBody(document: MdDocument, body: string): MdDocument {
  const hasTitle = /^# [^\n]*(?:\n|$)/.test(document.introduction);
  return { ...document, introduction: [hasTitle ? `# ${pageTitle(document).title}` : '', body].filter(Boolean).join('\n\n') };
}
