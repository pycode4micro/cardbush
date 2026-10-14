import GithubSlugger from 'github-slugger';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';

export function decodeFragment(value: string) { try { return decodeURIComponent(value); } catch { return value; } }

function headingText(node: Nodes): string {
  if (node.type === 'html') return '';
  if ('children' in node) return node.children.map(headingText).join('');
  if ('alt' in node) return node.alt ?? '';
  return 'value' in node ? node.value : '';
}

export function markdownOutline(source: string, scope: string) {
  const slugger = new GithubSlugger();
  const headings: { id: string; slug: string; label: string; depth: number; line: number }[] = [];
  const visit = (node: Nodes) => {
    if (node.type === 'heading') {
      const label = headingText(node), line = node.position?.start.line ?? 0;
      headings.push({ id: `${scope}-${line}`, slug: slugger.slug(label), label, depth: node.depth, line });
    }
    if ('children' in node) node.children.forEach(visit);
  };
  visit(fromMarkdown(source));
  return headings;
}

function visibleHeadingText(node: Node): string {
  if (node instanceof HTMLImageElement) return node.alt;
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return headingText(fromMarkdown(node.value));
  return node.nodeType === Node.TEXT_NODE ? node.textContent ?? '' : [...node.childNodes].map(visibleHeadingText).join('');
}

/** Resolve within this document, never a different editor/inspector or the app route. */
export function findMarkdownAnchor(root: HTMLElement, fragment: string): HTMLElement | undefined {
  const name = decodeFragment(fragment.replace(/^#/, ''));
  if (!name) return root;
  const exact = [...root.querySelectorAll<HTMLElement>('[id], a[name], [data-document-section]')]
    .find(element => element.id === name || element.getAttribute('name') === name || element.dataset.documentSection === name);
  if (exact) return exact;
  const slugger = new GithubSlugger();
  for (const element of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,.bush-page-title,.bush-section-title')) {
    if (element.closest('.bush-page-configuration, .md-node-editor')) continue;
    if (slugger.slug(visibleHeadingText(element)) === name) return element;
  }
}

export function scrollMarkdownAnchor(root: HTMLElement | null | undefined, fragment: string) {
  const target = root && findMarkdownAnchor(root, fragment);
  if (!target) return false;
  target.scrollIntoView({ block: 'start', inline: 'nearest' });
  return true;
}
