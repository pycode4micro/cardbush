import { PixelToolIcon } from './PixelToolIcon';
import { builtinToolProp } from './pixelToolArt';
import { PluginIcon } from '../../components/PluginIcon';

export function ToolLogo({
  name,
  size = 16,
  className = '',
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const normalized = name.trim().toLowerCase();
  const prop = builtinToolProp(normalized);
  if (!prop && normalized.startsWith('mcp__')) {
    return (
      <PluginIcon
        className={`tool-logo ${className}`.trim()}
        size={size}
      />
    );
  }
  return <PixelToolIcon prop={prop ?? 'wrench'} className={`tool-logo ${className}`.trim()} size={size}/>;
}
