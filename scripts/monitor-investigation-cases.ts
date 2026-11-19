import type { MonitorSnapshot } from "../lib/types";

export type MonitorFixtureSnapshot = Omit<
  MonitorSnapshot,
  "snapshotId" | "userId" | "targetSessionId" | "omittedSessions" | "sessions"
> & {
  sessions: (Omit<MonitorSnapshot["sessions"][number], "reasoningVisible"> & {
    reasoningVisible?: boolean;
  })[];
};
