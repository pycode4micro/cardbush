import sprite from './pixel-robot.png';
import type { AssistantSkin, SpriteSheet } from '../assistantSkin';

const faceLayers = (eyes: string) => [
  { path: 'M9 10h14v7H9z', fill: '#243a45' },
  { path: eyes, fill: '#a0f0d7' },
];
const robotFrames: SpriteSheet = {
  image: sprite, columns: 8, rows: 10,
  clips: {
    idle:      { row: 0, frames: 8, durationMs: 5200, iterations: 'infinite' },
    thinking:  { row: 1, frames: 8, durationMs: 1450, sustain: { frame: 2, durationMs: 2300 }, stageCue: 'thought' },
    working:   { row: 2, frames: 8, durationMs: 950, iterations: 2, sustain: { frame: 1, durationMs: 1650 } },
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
  props: {
    anchor: { x: 53, y: 51, size: 46 },
    gestures: { pencil: 'write', brush: 'write', lens: 'scan', page: 'scan', terminal: 'type', screen: 'type' },
  },
  expressions: { viewBox: '0 0 32 32', poses: {
    happy: { layers: faceLayers('M10 12h4v2h-1v-1h-2v1h-1z M18 12h4v2h-1v-1h-2v1h-1z M14 15h4v1h-4z'), gesture: 'nod' },
    curious: { layers: faceLayers('M10 10h4v1h-4z M12 12h2v3h-2z M19 13h3v2h-3z'), gesture: 'glance' },
    caring: { layers: faceLayers('M10 12h1v1h2v-1h1v2h-4z M18 12h1v1h2v-1h1v2h-4z M15 15h2v1h-2z'), gesture: 'soften' },
    surprised: { layers: faceLayers('M10 11h4v4h-4z M11 12v2h2v-2z M18 11h4v4h-4z M19 12v2h2v-2z M15 15h2v2h-2z'), gesture: 'lift' },
  } },
};
