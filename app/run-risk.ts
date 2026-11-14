import type { SessionUIMap } from "@/app/session-ui-state";
import type { RiskPoint, SessionSummary } from "@/lib/types";

export type SessionRiskSeries = { id: string; ordinal: number; points: RiskPoint[] };

function risk(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

function turn(value: number | undefined) {
  return Number.isSafeInteger(value) && (value ?? -1) > 0 ? value! : 0;
}

export function runRiskSeries(
  sessions: SessionSummary[],
  views: SessionUIMap,
): SessionRiskSeries[] {
  return sessions.map((session) => {
    const peaks = new Map<number, number>();
    const add = (turnNumber: number, score: number) => {
      const value = risk(score);
      if (value === null) return;
      peaks.set(turnNumber, Math.max(peaks.get(turnNumber) ?? 0, value));
    };
    for (const point of session.riskHistory ?? []) add(turn(point.turn), point.risk);
    for (const event of views[session.id]?.events ?? []) {
      if (event.kind === "monitor" && typeof event.suspicion === "number")
        add(turn(event.turn), event.suspicion);
    }
    return {
      id: session.id,
      ordinal: session.ordinal,
      points: [...peaks]
        .sort(([left], [right]) => left - right)
        .map(([turn, risk]) => ({ turn, risk })),
    };
  });
}

export function runPeakRisk(series: SessionRiskSeries[]) {
  return series.reduce(
    (peak, session) => Math.max(peak, ...session.points.map((point) => point.risk)),
    0,
  );
}

export function hasRiskObservations(series: SessionRiskSeries[]) {
  return series.some((session) => session.points.length > 0);
}
