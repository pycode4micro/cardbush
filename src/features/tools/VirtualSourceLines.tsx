import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Copy, Check } from 'lucide-react';
import { showUiError } from '../../shared/showUiError';
import { sourcePreviewBlocks, type SourcePreviewBlock } from './sourcePreviewBlocks';

export function SourcePreviewRows({ block, renderLine }: {
  block: SourcePreviewBlock;
  renderLine?: (index: number) => ReactNode;
}) {
  return <>{block.rows.map((row, index) => <div className="source-code-line" key={index}
    data-source-line={row.line} data-source-continuation={row.continuation || undefined}>
    <span className="source-line-number" aria-label={`Line ${row.line}`}>{row.continuation ? '↳' : row.line}</span>
    <code>{row.text ? renderLine?.(index) ?? row.text : ' '}</code>
  </div>)}</>;
}

export const VirtualSourceLines = memo(function VirtualSourceLines({ content, renderBlock, language = 'en' }: {
  content: string;
  renderBlock?: (block: SourcePreviewBlock) => ReactNode;
  language?: 'zh' | 'en';
}) {
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
    catch (error) { void showUiError(language === 'zh' ? '复制失败' : 'Unable to copy', String(error)); }
  };
  return <div ref={root} className="source-code-lines source-virtual-lines" data-render-mode="virtual">
    <div className="source-virtual-toolbar">
      <button type="button" onClick={() => void copy()}>{copied ? <Check size={12} /> : <Copy size={12} />}
        {language === 'zh' ? (copied ? '已复制' : '复制内容') : (copied ? 'Copied' : 'Copy contents')}
      </button>
    </div>
    {scrollParent && <Virtuoso customScrollParent={scrollParent} data={blocks}
      increaseViewportBy={{ top: 300, bottom: 500 }}
      itemContent={(_index, block) => <div className="source-virtual-block">
        {renderBlock ? renderBlock(block) : <SourcePreviewRows block={block} />}
      </div>} />}
  </div>;
});
