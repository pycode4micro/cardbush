/** Local HTML/CSS artwork. No generated scripts, network or host capabilities. */
export function FriendAvatar({ state = 'idle' }: { state?: 'idle' | 'listening' | 'working' | 'done' }) {
  return <div className="friend-avatar" data-state={state} aria-hidden="true">
    <div className="friend-avatar-shadow"/><div className="friend-avatar-body">
      <i className="friend-avatar-glow"/><div className="friend-avatar-face"><i/><i/><b/></div>
    </div><i className="friend-avatar-spark"/>
  </div>;
}
