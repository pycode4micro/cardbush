import { Fragment, memo } from 'react';
import { Highlight } from 'prism-react-renderer';
import { Prism } from '../../shared/syntaxPrism';
import { cardbushSyntaxTheme } from '../../shared/syntaxTheme';

export default memo(function MarkdownSyntaxCode({ content, grammar }: { content: string; grammar: string }) {
  return <Highlight prism={Prism} code={content} language={grammar} theme={cardbushSyntaxTheme}>
    {({ tokens, getTokenProps }) => <code className={`language-${grammar} syntax-highlighted`}>
      {tokens.map((line, lineIndex) => <Fragment key={lineIndex}>
        {lineIndex > 0 ? '\n' : null}
        {line.map((token, tokenIndex) => token.empty ? null : <span {...getTokenProps({ token })} key={tokenIndex} />)}
      </Fragment>)}
    </code>}
  </Highlight>;
});
