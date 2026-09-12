import { Fragment, useState } from 'react';
import { fileUrl } from '../../shared/localPaths';
import { openInspector } from '../inspector/inspectorEvents';
import { usePluginCatalog } from './pluginCatalog';
import { findReferencedPlugin, pluginPromptParts, type PluginLinkReference } from './pluginPrompts';

export function PluginReferenceLink({ reference }: { reference: PluginLinkReference }) {
  const plugin = findReferencedPlugin(reference, usePluginCatalog());
  const name = plugin?.name || reference.id;
  const logo = plugin?.logoPath || plugin?.logoDarkPath || '';
  const [failedLogo, setFailedLogo] = useState('');
  return <a className="plugin-reference-token" data-plugin-id={reference.id}
    href={fileUrl(reference.manifestPath)} title={`$${reference.id}\n${reference.manifestPath}`}
    onClick={event => { event.preventDefault(); openInspector(reference.manifestPath, name); }}>
    {logo && failedLogo !== logo
      ? <img src={fileUrl(logo)} alt="" draggable={false} onError={() => setFailedLogo(logo)} />
      : <span className="composer-plugin-fallback" aria-hidden="true">$</span>}
    <span>{name}</span>
  </a>;
}

/** Keep explicit plugin tokens readable while the Markdown renderer is loading. */
export function PluginPromptFallback({ content }: { content: string }) {
  return <>{pluginPromptParts(content, []).map(part => <Fragment key={part.start}>
    {part.reference ? <PluginReferenceLink reference={part.reference} /> : part.text}
  </Fragment>)}</>;
}
