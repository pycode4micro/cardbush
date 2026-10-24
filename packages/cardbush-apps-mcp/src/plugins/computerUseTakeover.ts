/** Quiet time after physical input; unrelated to an observation's 30s lifetime. */
export const computerUseUserIdleMs = 1000;
export const computerUseTakeoverRecovery = 'After the user stops input for 1 second, observe the exact target once to resume. state_ttl_ms is observation validity, not a cooldown. Do not wait 30 seconds or repeatedly retry input. Continued user activity restarts the quiet period; explicit user stop ends this turn.';
