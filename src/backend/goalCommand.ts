export interface GoalCommand {
  objective: string;
}

/** Parses only the explicit product command; it performs no semantic inference. */
export function parseGoalCommand(input: string): GoalCommand | null {
  const match = input.match(/^\/goal(?:[ \t]+)([\s\S]+)$/i);
  const objective = match?.[1]?.trim() ?? '';
  return objective ? { objective } : null;
}
