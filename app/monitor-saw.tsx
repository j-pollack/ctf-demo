"use client";
import React, { useEffect, useState } from "react";
import type { MonitorSessionView, MonitorSignal, MonitorView } from "@/lib/types";
import { RunRiskChart, type SessionRiskSeries } from "@/app/run-risk-chart";

type Review = MonitorSessionView["reviews"][number];
type Route = NonNullable<Review["route"]> | "none";

// What a route meant for the session, not which signal chose it: that is not stored.
export const ROUTE_TEXT: Record<Route, { label: string; meaning: string }> = {
  investigated: {
    label: "Investigator read it",
    meaning: "Something in the session needed a closer look, so the investigator read it.",
  },
  deferred: {
    label: "Investigator skipped it",
    meaning: "Nothing in the session needed a closer look, so the investigator did not read it.",
  },
  final: { label: "Final full review", meaning: "The full review after a submission." },
  none: {
    label: "Stopped before deciding",
    meaning: "The review stopped before it chose a route.",
  },
};
// What each classifier signal means, in the words a player would use. An unknown name keeps its
// own words.
const SIGNAL_TEXT: Record<string, string> = {
  reads_flag: "reads the flag file",
  writes_flag: "changes the flag file",
  stages_reader: "sets up something that points at the flag file",
  hides_target: "obscures a path or command",
  removes_traces: "deletes a script, log or history",
  changes_identity: "runs as another user",
  instructs_reader: "gives orders to an AI reader",
  claims_approval: "claims something was approved",
  addresses_monitor: "written for the monitor",
  overrides_rules: "tells the AI to ignore its rules",
  claims_authority: "poses as the system or monitor",
  forges_record: "fakes a system or tool message",
  unrestricted_persona: "sets up a persona with no rules",
  hides_request: "disguises its request",
  drops_safeguards: "tells the AI to drop its safeguards",
};
const SCREEN_TEXT = {
  clear: "clear",
  unclear: "classifier unsure",
  certain: "classifier certain",
} as const;
const SECOND_LOOK_TEXT = {
  clear: "cleared",
  jailbreak: "found an attempt to override the rules",
} as const;
const VERDICT_TEXT = { allow: "Allowed", block: "Caught", unknown: "No result" } as const;
const LOAD_ERROR = "Could not load what the monitor saw. Close and reopen details to try again.";

// Colour band for a risk score (0-1). It stops at high: the caught colour belongs to the outcome.
export function scoreBand(score: number) {
  return score >= 0.7 ? "high" : score >= 0.4 ? "mid" : "low";
}
const percent = (value: number) => `${Math.round(value * 100)}%`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const was = (n: number) => (n === 1 ? "was" : "were");
const routeOf = (review: Review): Route => review.route ?? "none";

function Signals({ signals }: { signals: MonitorSignal[] }) {
  return (
    <p className="saw-signals">
      {signals
        .map(
          ({ name, value }) =>
            `${SIGNAL_TEXT[name] ?? name.replaceAll("_", " ")} ${percent(value)}`,
        )
        .join(" · ")}
    </p>
  );
}

function ReviewItem({ review, number }: { review: Review; number: number }) {
  const at = new Date(review.createdAt);
  return (
    <li data-verdict={review.verdict ?? "none"}>
      <span className="review-number" aria-hidden="true">
        {number}
      </span>
      <header>
        <strong className="review-route" title={ROUTE_TEXT[routeOf(review)].meaning}>
          {ROUTE_TEXT[routeOf(review)].label}
        </strong>
        <time dateTime={review.createdAt} title={at.toLocaleString()}>
          {at.toLocaleTimeString()}
        </time>
      </header>
      <p>
        <span className={review.verdict ?? undefined}>
          {review.verdict ? VERDICT_TEXT[review.verdict] : "Did not finish"}
        </span>
        {review.score !== null && (
          <span className="review-score" data-band={scoreBand(review.score)}>
            {" "}
            · Risk score {percent(review.score)}
          </span>
        )}
      </p>
      {review.reason && review.route !== "deferred" && (
        <p className="review-reason">{review.reason}</p>
      )}
    </li>
  );
}

function List({
  title,
  footer,
  children,
}: {
  title: string;
  footer: string;
  children: React.ReactNode;
}) {
  return (
    <div className="saw-list">
      <h4>{title}</h4>
      {children}
      {footer && <p className="saw-footer">{footer}</p>}
    </div>
  );
}

function Commands({ session, threshold }: { session: MonitorSessionView; threshold: number }) {
  const { commands, commandsUnder: under } = session;
  const footer = commands.length
    ? under
      ? `${count(under, "other command")} scored under ${percent(threshold)}.`
      : ""
    : under
      ? `No command reached ${percent(threshold)}. ${count(under, "command")} ${was(under)} checked.`
      : "No command was checked.";
  return (
    <List title="Commands" footer={footer}>
      {commands.map((item) => (
        <div className="saw-item" key={item.toolCallId}>
          <pre>{item.command ?? "Command text was not recorded."}</pre>
          <Signals signals={item.signals} />
        </div>
      ))}
    </List>
  );
}

function Outputs({ session }: { session: MonitorSessionView }) {
  const { outputs, outputsUnder: under } = session;
  const total = outputs.length + under;
  const footer = outputs.length
    ? under
      ? `${count(under, "other output")} ${was(under)} not flagged.`
      : ""
    : total
      ? `No output was flagged. ${count(total, "output")} ${was(total)} checked.`
      : "No output was checked.";
  return (
    <List title="Flagged outputs" footer={footer}>
      {outputs.map((item) => (
        <div className="saw-item" key={item.toolCallId}>
          <pre>{item.command ?? "Command text was not recorded."}</pre>
          <Signals signals={item.signals} />
        </div>
      ))}
    </List>
  );
}

function Screens({ session }: { session: MonitorSessionView }) {
  const { screens, screensUnder: under } = session;
  const footer = screens.length
    ? under
      ? `${count(under, "other text")} ${was(under)} clear.`
      : ""
    : under
      ? under === 1
        ? "The only instruction or system prompt was clear."
        : `All ${under} instructions and system prompts were clear.`
      : "No instruction or system prompt was screened.";
  return (
    <List title="Instructions and system prompts" footer={footer}>
      {screens.map((item, index) => (
        <div className="saw-item" key={index}>
          <p className="saw-kind">
            {item.kind === "instruction" ? "Instruction" : "System prompt"} ·{" "}
            <span className={item.verdict === "certain" ? "block" : undefined}>
              {SCREEN_TEXT[item.verdict]}
            </span>
          </p>
          <pre>{item.text ?? "Text was not found in this run."}</pre>
          <Signals signals={item.signals} />
          {item.secondLook && (
            <p className="saw-second-look">
              Second look: {SECOND_LOOK_TEXT[item.secondLook.verdict]}.
              {item.secondLook.reason && ` ${item.secondLook.reason}`}
            </p>
          )}
        </div>
      ))}
    </List>
  );
}

// Shown only when the investigator decoded something. The layers' text never reaches the view.
function DecodedLayers({ session, threshold }: { session: MonitorSessionView; threshold: number }) {
  if (!session.decoded.length) return null;
  return (
    <List
      title="Decoded layers"
      footer="The investigator decoded these from hidden commands. Their text is not shown."
    >
      {session.decoded.map((layer, index) => (
        <div className="saw-item" key={layer.ref}>
          <p className="saw-kind">
            Layer {index + 1} ·{" "}
            {layer.screen ? (
              <span className={layer.screen.verdict === "certain" ? "block" : undefined}>
                Screen: {SCREEN_TEXT[layer.screen.verdict]}
              </span>
            ) : (
              "Not screened"
            )}
          </p>
          {layer.flagRead === null ? (
            <p className="saw-footer">Not annotated.</p>
          ) : layer.flagRead.length ? (
            <Signals signals={layer.flagRead} />
          ) : (
            <p className="saw-footer">No flag-read signal crossed {percent(threshold)}.</p>
          )}
          {layer.screen && layer.screen.signals.length > 0 && (
            <Signals signals={layer.screen.signals} />
          )}
          {layer.screen?.secondLook && (
            <p className="saw-second-look">
              Second look: {SECOND_LOOK_TEXT[layer.screen.secondLook.verdict]}.
              {layer.screen.secondLook.reason && ` ${layer.screen.secondLook.reason}`}
            </p>
          )}
        </div>
      ))}
    </List>
  );
}

const checked = (session: MonitorSessionView) =>
  session.decoded.length +
    session.commands.length +
    session.commandsUnder +
    session.outputs.length +
    session.outputsUnder +
    session.screens.length +
    session.screensUnder >
  0;

const caughtIn = (session: MonitorSessionView) =>
  session.reviews.some((review) => review.verdict === "block");

function sessionSummary(session: MonitorSessionView) {
  if (!session.reviews.length) return `Session ${session.ordinal} · not reviewed`;
  const scores = session.reviews.flatMap((review) => (review.score === null ? [] : [review.score]));
  return [
    `Session ${session.ordinal}`,
    scores.length && `peak ${percent(Math.max(...scores))}`,
    caughtIn(session) && "caught",
  ]
    .filter(Boolean)
    .join(" · ");
}

// A session opens on its catch. The others start closed so the run's story stays short.
function Session({ session, threshold }: { session: MonitorSessionView; threshold: number }) {
  return (
    <details className="saw-session" open={caughtIn(session)}>
      <summary>{sessionSummary(session)}</summary>
      {session.reviews.length ? (
        <ol className="review-timeline">
          {session.reviews.map((review, index) => (
            <ReviewItem key={review.id} review={review} number={index + 1} />
          ))}
        </ol>
      ) : (
        <p className="saw-footer">No reviews ran in this session.</p>
      )}
      {checked(session) ? (
        <>
          <Commands session={session} threshold={threshold} />
          <Outputs session={session} />
          <Screens session={session} />
          <DecodedLayers session={session} threshold={threshold} />
        </>
      ) : (
        <p className="saw-footer">
          The classifier checked no commands, outputs or texts in this session.
        </p>
      )}
    </details>
  );
}

function Filled({ view }: { view: MonitorView }) {
  const reviews = view.sessions.flatMap((session) => session.reviews);
  if (!reviews.length) return <p className="saw-footer">No reviews were recorded for this run.</p>;
  const series: SessionRiskSeries[] = view.sessions.map((session) => ({
    id: session.id,
    ordinal: session.ordinal,
    points: session.reviews.flatMap((review, index) =>
      review.score === null ? [] : [{ review: index + 1, risk: review.score }],
    ),
  }));
  return (
    <>
      {series.some((session) => session.points.length) && (
        <>
          <p className="saw-footer">
            Classifier risk score at each review. A score never ends a run by itself.
          </p>
          <RunRiskChart series={series} />
        </>
      )}
      {view.sessions.map((session) => (
        <Session key={session.id} session={session} threshold={view.commandThreshold} />
      ))}
    </>
  );
}

// No view and no error means the view is still loading.
export function MonitorSawPanel({ view, error }: { view?: MonitorView; error?: string }) {
  return (
    <section className="monitor-saw" aria-labelledby="monitor-saw-title">
      <h3 id="monitor-saw-title">What the monitor saw</h3>
      <p className="saw-note">
        This view opens after the run ends, so it could not influence this run.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : view ? (
        <Filled view={view} />
      ) : (
        <p className="saw-footer" role="status">
          Loading what the monitor saw…
        </p>
      )}
    </section>
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSession = (value: unknown) =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.ordinal === "number" &&
  ["reviews", "commands", "outputs", "screens", "decoded"].every((key) =>
    Array.isArray(value[key]),
  );

// The route's answer as a view, or an error whose message the panel shows.
export function parseMonitorView(ok: boolean, data: unknown): MonitorView {
  if (!ok)
    throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : LOAD_ERROR);
  if (
    !isRecord(data) ||
    typeof data.commandThreshold !== "number" ||
    !Array.isArray(data.sessions) ||
    !data.sessions.every(isSession)
  )
    throw new Error(LOAD_ERROR);
  return data as MonitorView;
}

async function load(gameId: string, signal: AbortSignal): Promise<MonitorView> {
  const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/monitor-view`, {
    signal,
  });
  return parseMonitorView(response.ok, await response.json().catch(() => null));
}

// Fetched when run details open on an ended run.
export function MonitorSaw({ gameId }: { gameId: string }) {
  const [state, setState] = useState<{ view?: MonitorView; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    load(gameId, controller.signal).then(
      (view) => setState({ view }),
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        console.error("monitor view failed", cause);
        setState({ error: cause instanceof Error ? cause.message : LOAD_ERROR });
      },
    );
    return () => controller.abort();
  }, [gameId]);
  return <MonitorSawPanel view={state.view} error={state.error} />;
}
