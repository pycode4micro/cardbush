import { uiText } from '../../i18n';
import { useUiLanguage } from '../../i18n/react';
import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Copy, Check } from 'lucide-react';
import { showUiError } from '../../shared/showUiError';
import { sourcePreviewBlocks, type SourcePreviewBlock } from './sourcePreviewBlocks';

export function SourcePreviewRows({ block, renderLine }: {
  block: SourcePreviewBlock;
  renderLine?: (index: number) => ReactNode;
}) {
  const language = useUiLanguage();
  return <>{block.rows.map((row, index) => <div className="source-code-line" key={index}
    data-source-line={row.line} data-source-continuation={row.continuation || undefined}>
    <span className="source-line-number" aria-label={uiText(language)('source.lineNumber', { number: row.line })}>{row.continuation ? '↳' : row.line}</span>
    <code>{row.text ? renderLine?.(index) ?? row.text : ' '}</code>
  </div>)}</>;
}

export const VirtualSourceLines = memo(function VirtualSourceLines({ content, renderBlock, language: selectedLanguage }: {
  content: string;
  renderBlock?: (block: SourcePreviewBlock) => ReactNode;
  language?: string;
}) {
  const inheritedLanguage = useUiLanguage();
  const language = selectedLanguage ?? inheritedLanguage;
  const root = useRef<HTMLDivElement>(null);
  const [scrollParent, setScrollParent] = useState<HTMLElement>();
  const [copied, setCopied] = useState(false);
  const blocks = useMemo(() => sourcePreviewBlocks(content), [content]);
  useLayoutEffect(() => {
    const parent = root.current?.closest<HTMLElement>('.source-inspector-document, .markdown-inspector-document');
    if (parent) setScrollParent(parent);
  }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(content); setCopied(true); }
    catch (error) { void showUiError(uiText(language)('virtualSourceLines.unableToCopy'), String(error)); }
  };
  return <div ref={root} className="source-code-lines source-virtual-lines" data-render-mode="virtual">
    <div className="source-virtual-toolbar">
      <button type="button" onClick={() => void copy()}>{copied ? <Check size={12} /> : <Copy size={12} />}
        {(copied ? uiText(language)('browserConnectionSettings.copied') : uiText(language)('virtualSourceLines.copyContents'))}
      </button>
    </div>
    {scrollParent && <Virtuoso customScrollParent={scrollParent} data={blocks}
      increaseViewportBy={{ top: 300, bottom: 500 }}
      itemContent={(_index, block) => <div className="source-virtual-block">
        {renderBlock ? renderBlock(block) : <SourcePreviewRows block={block} />}
      </div>} />}
  </div>;
});
