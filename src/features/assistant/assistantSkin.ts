import sprite from './art/pixel-robot.png';
import type { AssistantActivity } from './assistantActivity';

/** Frame zero is the resting pose after a gesture and when motion is reduced. */
type SpriteClip = {
  row: number;
  frames: number;
  durationMs: number;
  iterations?: number | 'infinite';
  stageCue?: 'thought' | 'terminal' | 'hourglass';
};
export interface SpriteSheet {
  image: string;
  columns: number;
  rows: number;
  clips: { idle: SpriteClip } & Partial<Record<AssistantActivity, SpriteClip>>;
}
export interface AssistantSkin {
  portrait: SpriteSheet;
}
const robotFrames: SpriteSheet = {
  image: sprite, columns: 8, rows: 10,
  clips: {
    idle:      { row: 0, frames: 8, durationMs: 5200, iterations: 'infinite' },
    thinking:  { row: 1, frames: 8, durationMs: 1450, stageCue: 'thought' },
    working:   { row: 2, frames: 8, durationMs: 950, iterations: 2, stageCue: 'terminal' },
    waiting:   { row: 3, frames: 8, durationMs: 2300, stageCue: 'hourglass' },
    retrying:  { row: 4, frames: 8, durationMs: 1600 },
    error:     { row: 5, frames: 8, durationMs: 2200 },
    connecting:{ row: 6, frames: 8, durationMs: 1100 },
    listening: { row: 7, frames: 8, durationMs: 1400 },
    speaking:  { row: 8, frames: 8, durationMs: 720, iterations: 'infinite' },
    muted:     { row: 9, frames: 8, durationMs: 3600 },
  },
};
export const pixelRobot: AssistantSkin = {
  portrait: robotFrames,
};
