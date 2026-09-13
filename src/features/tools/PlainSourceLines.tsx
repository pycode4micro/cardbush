import { shouldUsePlainTextPreview } from '../../shared/textPreview';

export function PlainSourceLines({ content }: { content: string }) {
  const normalized = content.replace(/\r\n?/g, '\n');
  if (shouldUsePlainTextPreview(normalized)) {
    return <pre className="source-plain-text" data-render-mode="plain">{normalized}</pre>;
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
