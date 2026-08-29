import { createHash } from "node:crypto";

import {
  BUSH_TEAM_SNAPSHOT_RESULT_PROTOCOL,
  teamSnapshotSchema,
  type TeamDefinition,
  type TeamSnapshot,
  type TeamSnapshotResult,
} from "@cardbush/bush-protocol";

export class TeamSnapshotStore {
  readonly #canApply: () => boolean;
  #snapshot?: TeamSnapshot;
  #result?: TeamSnapshotResult;

  constructor(options: { canApply?: () => boolean } = {}) {
    this.#canApply = options.canApply ?? (() => true);
  }

  apply(input: unknown): TeamSnapshotResult {
    const snapshot = teamSnapshotSchema.parse(input);
    if (!this.#canApply()) {
      throw new Error("Team configuration cannot change while a Runtime Turn is active.");
    }
    if (this.#snapshot?.snapshotId === snapshot.snapshotId) {
      if (snapshot.revision < this.#snapshot.revision) {
        throw new Error("Team snapshot revision cannot move backwards.");
      }
      if (snapshot.revision === this.#snapshot.revision) {
        if (fingerprint(snapshot) !== fingerprint(this.#snapshot)) {
          throw new Error("Team snapshot identity was reused with different content.");
        }
        return structuredClone(this.#result!);
      }
    }
    this.#snapshot = snapshot;
    this.#result = {
      protocol: BUSH_TEAM_SNAPSHOT_RESULT_PROTOCOL,
      snapshotId: snapshot.snapshotId,
      revision: snapshot.revision,
      teamCount: snapshot.teams.length,
      memberCount: snapshot.teams.reduce((count, team) => count + team.members.length, 0),
    };
    return structuredClone(this.#result);
  }

  result(): TeamSnapshotResult | undefined {
    return this.#result ? structuredClone(this.#result) : undefined;
  }

  team(teamId: string): TeamDefinition | undefined {
    const team = this.#snapshot?.teams.find((candidate) => candidate.teamId === teamId);
    return team ? structuredClone(team) : undefined;
  }
}

function fingerprint(snapshot: TeamSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
