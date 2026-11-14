import type { CSSProperties, ReactNode } from 'react';
import type { AssistantReplyExpression } from '@cardbush/bush-protocol';
import { useAssistantActivity, useAssistantExpression, useAssistantTool, type AssistantActivity } from './assistantActivity';
import type { AssistantSkin, SpriteSheet } from './assistantSkin';
import { useAssistantSkin } from './assistantSkinContext';
import { PixelToolIcon } from '../tools/PixelToolIcon';
import { toolProp } from '../tools/pixelToolArt';
import './assistantCharacter.css';

function SpriteFilm({ state, sheet, className, children }: { state: AssistantActivity; sheet: SpriteSheet; className: string; children?: ReactNode }) {
  const clip = sheet.clips[state] ?? sheet.clips.idle;
  const sustain = typeof clip.iterations !== 'string' ? clip.sustain : undefined;
  const geometry = {
    '--sheet-width': `${sheet.columns * 100}%`, '--sheet-height': `${sheet.rows * 100}%`,
    '--clip-y': `${-100 * clip.row / sheet.rows}%`, '--clip-end': `${-100 * clip.frames / sheet.columns}%`,
    '--clip-frames': clip.frames, '--clip-duration': `${clip.durationMs}ms`,
    '--clip-iterations': clip.iterations ?? 1,
    ...(sustain ? {
      '--sustain-delay': `${clip.durationMs * Number(clip.iterations ?? 1)}ms`,
      '--sustain-duration': `${sustain.durationMs}ms`,
      '--sustain-frame': `${-100 * sustain.frame / sheet.columns}%`,
    } : {}),
  } as CSSProperties;
  return <span className={`assistant-sprite ${className}`} data-state={state} data-sustain={sustain ? '' : undefined} aria-hidden="true" style={geometry}>
    <img key={state} src={sheet.image} alt="" draggable={false}/>
    {children}
  </span>;
}

export function AssistantPortrait({ state, skin: override, expression, toolName }: {
  state: AssistantActivity; skin?: AssistantSkin; expression?: AssistantReplyExpression; toolName?: string;
}) {
  const current = useAssistantSkin(), skin = override ?? current;
  const face = expression && ['idle', 'thinking', 'working'].includes(state) ? skin.expressions?.poses[expression.mood] : undefined;
  const prop = toolName && ['working', 'thinking'].includes(state) ? toolProp(toolName) : undefined;
  const mount = skin.props?.anchor;
  return <SpriteFilm state={state} sheet={skin.portrait} className="assistant-character">
    {face && expression && <svg key={expression.replyId} className="robot-expression" data-expression={expression.mood} data-gesture={face.gesture}
      viewBox={skin.expressions!.viewBox} shapeRendering="crispEdges" aria-hidden="true">
      {face.layers.map((layer, index) => <path key={index} d={layer.path} fill={layer.fill} fillRule="evenodd"/>)}
    </svg>}
    {prop && mount && <span className="assistant-tool-prop" data-gesture={skin.props?.gestures?.[prop] ?? 'tap'} style={{ '--prop-x': `${mount.x}%`, '--prop-y': `${mount.y}%`, '--prop-size': `${mount.size}%` } as CSSProperties}>
      <PixelToolIcon prop={prop} path={skin.props?.paths?.[prop]}/>
    </span>}
  </SpriteFilm>;
}

export function AssistantStage({ state, skin: override }: {
  state: AssistantActivity; skin?: AssistantSkin;
}) {
  const expression = useAssistantExpression();
  const current = useAssistantSkin(), skin = override ?? current;
  const toolName = useAssistantTool();
  const cue = (skin.portrait.clips[state] ?? skin.portrait.clips.idle).stageCue;
  return <span className="assistant-stage" aria-hidden="true" data-state={state}>
    <span className="assistant-stage-actor">
      <AssistantPortrait state={state} skin={skin} expression={expression} toolName={toolName}/>
      {cue && !(toolName && state === 'thinking') && <span className="assistant-stage-cue" data-cue={cue}/>}
    </span>
  </span>;
}
export function AssistantCharacter() {
  return <AssistantPortrait state={useAssistantActivity()} expression={useAssistantExpression()} toolName={useAssistantTool()}/>;
}
