import type { AssistantExpression } from '@cardbush/bush-protocol';
import type { ToolProp } from '../tools/pixelToolArt';
import type { AssistantActivity } from './assistantActivity';

/** Frame zero is the resting pose after a gesture and when motion is reduced. */
type SpriteClip = {
  row: number;
  frames: number;
  durationMs: number;
  iterations?: number | 'infinite';
  /** Alternate briefly with frame zero after the opening gesture. */
  sustain?: { frame: number; durationMs: number };
  stageCue?: 'thought' | 'hourglass';
};
export interface SpriteSheet {
  image: string;
  columns: number;
  rows: number;
  clips: { idle: SpriteClip } & Partial<Record<AssistantActivity, SpriteClip>>;
}
export interface AssistantSkin {
  portrait: SpriteSheet;
  expressions?: {
    viewBox: string;
    poses: Partial<Record<AssistantExpression, { layers: ReadonlyArray<{ path: string; fill: string }>; gesture: 'nod' | 'glance' | 'soften' | 'lift' }>>;
  };
  props?: {
    anchor: { x: number; y: number; size: number };
    paths?: Partial<Record<ToolProp, string>>;
    gestures?: Partial<Record<ToolProp, 'tap' | 'scan' | 'write' | 'type'>>;
  };
}
