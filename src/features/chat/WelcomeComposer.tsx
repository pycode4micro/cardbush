import type { ReactNode } from 'react';

export function WelcomeComposer({ children, workspaceControl }: { children: ReactNode; workspaceControl?: ReactNode }) {
  return <div className="welcome-composer"><div className="new-chat-input">
    {workspaceControl && <div className="new-chat-workspace">{workspaceControl}</div>}
    {children}
  </div></div>;
}
