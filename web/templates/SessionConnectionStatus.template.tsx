export function SessionConnectionStatus({ phase, message }: {
  phase: 'starting' | 'reconnecting' | 'failed'; message: string;
}) {
  return <div className="session-connection-status" data-phase={phase} role={phase === 'failed' ? 'alert' : 'status'}>{message}</div>;
}
