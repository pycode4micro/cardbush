import { Suspense } from 'react';
import { shouldVirtualizeSource } from './sourcePreviewBlocks';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';

const VirtualSourceLines = recoverableLazy<{ content: string }>('virtual-source',
  () => import('./VirtualSourceLines').then(module => ({ default: module.VirtualSourceLines })),
  ({ content }) => <><DeferredModuleNotice language="en" basicPreview /><pre className="source-plain-text">{content}</pre></>);

export function PlainSourceLines({ content }: { content: string }) {
  const normalized = content.replace(/\r\n?/g, '\n');
  if (shouldVirtualizeSource(normalized)) {
    return <Suspense fallback={<pre className="source-plain-text" aria-busy="true">{normalized.slice(0, 8192)}</pre>}>
      <VirtualSourceLines content={normalized} />
    </Suspense>;
  }
  return (
    <div className="source-code-lines" data-render-mode="plain">
      {normalized.split('\n').map((line, index) => (
        <div className="source-code-line" key={index}>
          <span className="source-line-number" aria-label={`Line ${index + 1}`}>{index + 1}</span>
          <code>{line || ' '}</code>
        </div>
      ))}
    </div>
  );
}
