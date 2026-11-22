import { Highlight } from 'prism-react-renderer';
import { memo, useMemo } from 'react';
import { Prism } from '../../shared/syntaxPrism';
import { cardbushSyntaxTheme } from '../../shared/syntaxTheme';
import { DiffRows, type DiffRowsProps } from './DiffRows';
import { diffLanguageForPath, diffLineSource } from './diffSyntax';

export default memo(function DiffSyntaxLines({ path, ...rows }: DiffRowsProps & { path: string }) {
  const { lines, start, end } = rows;
  const code = useMemo(() => lines.slice(start, end).map(diffLineSource).join('\n'), [lines, start, end]);
  return <Highlight prism={Prism} code={code} language={diffLanguageForPath(path)} theme={cardbushSyntaxTheme}>
    {({ tokens, getTokenProps }) => (
      <div className="syntax-highlighted">
        <DiffRows {...rows} renderSource={index => tokens[index]?.map((token, tokenIndex) =>
          <span {...getTokenProps({ token })} key={tokenIndex} />)} />
      </div>
    )}
  </Highlight>;
});
