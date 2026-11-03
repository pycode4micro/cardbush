import './friendsTransition.css';

/** Temporary geometry belongs to the transition, never to a companion avatar. */
export function FriendsTransition() {
  return <div className="friends-transition" aria-hidden="true">
    <div className="friends-transition-wash"/>
  </div>;
}
