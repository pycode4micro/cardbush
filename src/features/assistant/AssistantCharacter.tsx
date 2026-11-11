import type { CSSProperties } from 'react';
import { useAssistantActivity, type AssistantActivity } from './assistantActivity';
import { useAssistantAvatar } from './assistantAvatar';
import { pixelRobot, type AssistantSkin, type SpriteSheet } from './assistantSkin';
import './assistantCharacter.css';

function SpriteFilm({ state, sheet, className }: { state: AssistantActivity; sheet: SpriteSheet; className: string }) {
  const clip = sheet.clips[state] ?? sheet.clips.idle;
  const geometry = {
    '--sheet-width': `${sheet.columns * 100}%`, '--sheet-height': `${sheet.rows * 100}%`,
    '--clip-y': `${-100 * clip.row / sheet.rows}%`, '--clip-end': `${-100 * clip.frames / sheet.columns}%`,
    '--clip-frames': clip.frames, '--clip-duration': `${clip.durationMs}ms`,
    '--clip-iterations': clip.iterations ?? 1,
  } as CSSProperties;
  return <span className={`assistant-sprite ${className}`} data-state={state} aria-hidden="true" style={geometry}>
    <img key={state} src={sheet.image} alt="" draggable={false}/>
  </span>;
}

export function AssistantPortrait({ state, avatar, skin = pixelRobot }: {
  state: AssistantActivity; avatar: string; skin?: AssistantSkin;
}) {
  if (avatar) return <span className="assistant-character assistant-avatar" data-state={state} aria-hidden="true"><img src={avatar} alt=""/></span>;
  return <SpriteFilm state={state} sheet={skin.portrait} className="assistant-character"/>;
}

export function AssistantStage({ state, avatar, skin = pixelRobot }: {
  state: AssistantActivity; avatar: string; skin?: AssistantSkin;
}) {
  const cue = (skin.portrait.clips[state] ?? skin.portrait.clips.idle).stageCue;
  return <span className="assistant-stage" aria-hidden="true" data-state={state}>
    <span className="assistant-stage-actor">
      <AssistantPortrait state={state} avatar={avatar} skin={skin}/>
      {!avatar && cue && <span className="assistant-stage-cue" data-cue={cue}/>}
    </span>
  </span>;
}
export function AssistantCharacter() {
  return <AssistantPortrait state={useAssistantActivity()} avatar={useAssistantAvatar()}/>;
}
