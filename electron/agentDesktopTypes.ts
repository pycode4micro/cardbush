/** Optional Personal Agent desktop protocol. Safe to import in the renderer. */
export type AgentDesktopStatus = {
  available: boolean;
  control: 'agent' | 'user';
  leaseExpiresAt: number | null;
  error?: string;
};
export type AgentDesktopFrame = AgentDesktopStatus & {
  frameId: string; capturedAt: number; width: number; height: number;
  mimeType: 'image/jpeg'; data: string;
};
export type AgentDesktopInput =
  | { action: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { action: 'drag'; x: number; y: number; toX: number; toY: number }
  | { action: 'scroll'; x: number; y: number; direction: 'up' | 'down'; steps?: number }
  | { action: 'key'; key: string }
  | { action: 'type'; text: string };
