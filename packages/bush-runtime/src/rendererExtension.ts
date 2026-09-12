/** Serializable state and DOM mounting keep the host independent of a plugin's UI framework. */
export interface RuntimeRendererHost {
  command: (kind: string, payload: unknown) => Promise<unknown>;
  synchronizeTools: () => Promise<void>;
  configurationFile: (input: { action: 'import' | 'export' | 'reveal'; text?: string; name?: string; yaml?: string }) => Promise<unknown>;
}
export interface RuntimeRendererSnapshot {
  title: string;
  role?: 'delegation';
  command?: string;
  instructions?: string;
  choices: Array<{ id: string; name: string; description: string }>;
  selectedId: string;
  loading?: boolean;
  error?: string;
}
export interface RuntimeRendererExtension<Container = unknown> {
  apiVersion: 1;
  getSnapshot: () => RuntimeRendererSnapshot;
  subscribe: (listener: () => void) => () => void;
  load: (force?: boolean) => Promise<void>;
  select: (id: string) => void;
  mount: (container: Container, slot: 'workspace' | 'sidebar' | 'content', props: Record<string, unknown>) => { update: (props: Record<string, unknown>) => void; dispose: () => void };
  prepareTurn?: (input: unknown, tools: unknown[]) => Promise<void>;
  invoke?: (action: string, payload?: unknown) => Promise<unknown>;
  dispose: () => void;
}
