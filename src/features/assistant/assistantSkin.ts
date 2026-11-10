import sprite from './art/pixel-robot.png';
import observatory from './art/observatory.png';
import observatoryDay from './art/observatory-day.png';
import type { ThemeMode } from '../../types';
import type { AssistantActivity } from './assistantActivity';

/** Each clip starts at column zero of its row. Frame zero also serves reduced motion. */
type SpriteClip = { row: number; frames: number; durationMs: number };
export interface SpriteSheet {
  image: string;
  themeImages?: Partial<Record<ThemeMode, string>>;
  columns: number;
  rows: number;
  clips: { idle: SpriteClip } & Partial<Record<AssistantActivity, SpriteClip>>;
}
export interface AssistantSkin {
  portrait: SpriteSheet;
  /** Panoramic clips fill the entire title bar. A scene can also supply its own character. */
  scene: SpriteSheet & { frameRatio: number; includesCharacter: boolean };
}
const robotFrames: SpriteSheet = {
  image: sprite, columns: 8, rows: 10,
  clips: {
    idle:      { row: 0, frames: 8, durationMs: 3600 },
    thinking:  { row: 1, frames: 8, durationMs: 1450 },
    working:   { row: 2, frames: 8, durationMs: 950 },
    waiting:   { row: 3, frames: 8, durationMs: 2300 },
    retrying:  { row: 4, frames: 8, durationMs: 1600 },
    error:     { row: 5, frames: 8, durationMs: 2200 },
    connecting:{ row: 6, frames: 8, durationMs: 1100 },
    listening: { row: 7, frames: 8, durationMs: 1400 },
    speaking:  { row: 8, frames: 8, durationMs: 720 },
    muted:     { row: 9, frames: 8, durationMs: 3600 },
  },
};
export const pixelRobot: AssistantSkin = {
  portrait: robotFrames,
  scene: { ...robotFrames, image: observatory, themeImages: { bright: observatoryDay }, frameRatio: 320 / 36, includesCharacter: false },
};
