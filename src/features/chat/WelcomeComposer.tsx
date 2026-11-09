import type { ReactNode } from 'react';

export function WelcomeComposer({ children }: { children: ReactNode }) {
  return <div className="welcome-composer"><div className="new-chat-input">{children}</div></div>;
}
