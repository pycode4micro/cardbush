import type { PrismTheme } from 'prism-react-renderer';

export const cardbushSyntaxTheme: PrismTheme = {
  plain: { color: 'var(--diff-syntax-text)' },
  styles: [
    {
      types: ['comment', 'prolog', 'doctype', 'cdata'],
      style: { color: 'var(--diff-syntax-comment)', fontStyle: 'italic' },
    },
    {
      types: ['punctuation'],
      style: { color: 'var(--diff-syntax-punctuation)' },
    },
    {
      types: ['property', 'tag', 'constant', 'symbol', 'attr-name'],
      style: { color: 'var(--diff-syntax-property)' },
    },
    {
      types: ['boolean', 'number'],
      style: { color: 'var(--diff-syntax-number)' },
    },
    {
      types: ['selector', 'string', 'char', 'builtin', 'inserted', 'attr-value'],
      style: { color: 'var(--diff-syntax-string)' },
    },
    {
      types: ['operator', 'entity', 'url'],
      style: { color: 'var(--diff-syntax-operator)' },
    },
    {
      types: ['atrule', 'keyword'],
      style: { color: 'var(--diff-syntax-keyword)' },
    },
    {
      types: ['function', 'class-name'],
      style: { color: 'var(--diff-syntax-function)' },
    },
    {
      types: ['regex', 'important', 'variable'],
      style: { color: 'var(--diff-syntax-variable)' },
    },
    {
      types: ['deleted'],
      style: { color: 'var(--diff-syntax-deleted)' },
    },
  ],
};
