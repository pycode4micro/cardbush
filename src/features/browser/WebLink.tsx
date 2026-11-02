import { isValidElement, type ComponentProps, type ReactNode } from 'react';
import { BrowserSiteIcon } from './BrowserSiteIcon';
import './web-link.css';

export function webLinkAddress(href: string | undefined): URL | undefined {
  if (!href || !/^(https?:\/\/|\/\/)/i.test(href)) return;
  try {
    const url = new URL(href, 'https://cardbush.invalid');
    if (url.protocol === 'http:' || url.protocol === 'https:') return url;
  } catch { /* Other reference types retain their own renderer. */ }
}

function labelText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(labelText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return labelText(node.props.children);
  return '';
}

function containsImage(node: ReactNode): boolean {
  if (Array.isArray(node)) return node.some(containsImage);
  if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(node)) return false;
  return node.type === 'img' || node.props.node?.tagName === 'img' || containsImage(node.props.children);
}

/** Authored titles win; bare URLs use their host as a stable label. Independent
 * site-icon discovery never replaces the label or the actual navigation target. */
export function WebLink({ href, children, title, className, ...props }: ComponentProps<'a'>) {
  const address = webLinkAddress(href);
  if (!address || containsImage(children)) return <a {...props} href={href} title={title} className={className}>{children}</a>;
  const text = labelText(children).trim();
  const bare = !text || text === href || /^(?:https?:\/\/|www\.)\S+$/i.test(text);
  const label = (bare ? title?.trim() : text) || address.hostname.replace(/^www\./i, '');
  return <a {...props} href={address.href} className={['web-link', className].filter(Boolean).join(' ')}
    title={`${label}\n${address.href}`} aria-label={props['aria-label'] ?? label}
    aria-description={props['aria-description'] ?? address.href}>
    <BrowserSiteIcon url={address.href} persist />
    <span className="web-link-title">{label}</span>
  </a>;
}
