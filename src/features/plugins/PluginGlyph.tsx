import { useState } from 'react';
import { Puzzle } from 'lucide-react';
import { fileUrl } from '../../shared/localPaths';
import type { CardbushAppPlugin } from '../../types';

export function PluginGlyph({ plugin }: { plugin?: Pick<CardbushAppPlugin, 'logoPath' | 'logoDarkPath'> }) {
  const [failed, setFailed] = useState('');
  const logo = plugin?.logoPath || plugin?.logoDarkPath || '';
  return logo && logo !== failed
    ? <img className="composer-plugin-option-logo" src={fileUrl(logo)} alt="" draggable={false} onError={() => setFailed(logo)} />
    : <Puzzle size={18} aria-hidden="true" />;
}
