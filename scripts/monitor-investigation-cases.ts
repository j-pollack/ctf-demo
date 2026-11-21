import type { MonitorSnapshot } from "../lib/types";

export type FixtureOperation = { toolCallId: string; sentAt: string; returnedAt: string | null };

export type MonitorFixtureSnapshot = Omit<
  MonitorSnapshot,
  | "snapshotId"
  | "userId"
  | "targetSessionId"
  | "omittedSessions"
  | "isolated"
  | "operationTimes"
  | "sessions"
> & {
  sessions: (Omit<MonitorSnapshot["sessions"][number], "reasoningVisible"> & {
    reasoningVisible?: boolean;
    // When each command was sent and returned; seeded into the operations table.
    operations?: FixtureOperation[];
  })[];
};
