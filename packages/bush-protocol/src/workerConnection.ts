export type WorkerConnectionAction = 'verify' | 'reconnect';
export type WorkerConnectionErrorCode = 'identity_changed' | 'authentication_failed' | 'network_unavailable' | 'verification_failed';
export interface WorkerConnectionSnapshot {
  id: string;
  name: string;
  agentId?: string;
  connected: boolean;
  connectionState: 'unverified' | 'disconnected' | 'connecting' | 'verifying' | 'connected' | 'reconnecting' | 'failed';
  lastCheckedAt?: string;
  verifiedAt?: string;
  connectionErrorCode?: WorkerConnectionErrorCode;
  connectionError?: string;
}
