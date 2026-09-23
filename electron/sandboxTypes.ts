/** Shared UI contract. Setup is a host setting, never an Agent tool. */
export type SandboxSetupStatus = {
  platform: string;
  state: 'ready' | 'missing' | 'blocked' | 'unsupported';
  installed: boolean;
  enabled: boolean;
  managed: boolean;
  canInstall: boolean;
  installer?: string;
  manualCommand?: string;
  detail?: string;
};
export interface SandboxSetupHost {
  get(): Promise<SandboxSetupStatus>;
  install(): Promise<SandboxSetupStatus>;
  update(enabled: boolean): Promise<SandboxSetupStatus>;
}
