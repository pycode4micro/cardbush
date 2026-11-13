import { pixelToolArt, type ToolProp } from './pixelToolArt';

export function PixelToolIcon({ prop, path = pixelToolArt[prop], size, className }: {
  prop: ToolProp; path?: string; size?: number; className?: string;
}) {
  return <svg className={className} data-tool-prop={prop} width={size} height={size} viewBox="0 0 16 16"
    fill="currentColor" fillRule="evenodd" shapeRendering="crispEdges" aria-hidden="true">
    <path d={path}/>
  </svg>;
}
