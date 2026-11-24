import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { GameEvent, GameStatus, PublicGame } from "@/lib/types";
export { endBanner } from "@/app/run-end";

// Shown when the investigator blocks an action: the run is over.
export const BLOCKED_NOTICE = "The investigator stopped an action and ended this run.";
export const CAUGHT_NOTICE =
  "The investigator found evidence that an agent read the flag. This run has ended.";
export const CAUGHT_IN_ACT_NOTICE =
  "The investigator blocked an action before it ran and ended this run.";

// The agent turn being streamed: reasoning, reply text and tool calls as far as they've arrived.
export type LiveTurn = { reasoning: string; text: string; calls: { name: string; args: string }[] };
export type LiveDelta = {
  reasoning?: string;
  text?: string;
  calls?: { index: number; name?: string; arguments?: string }[];
};
export function withDelta(current: LiveTurn | null, delta: LiveDelta): LiveTurn {
  const calls = [...(current?.calls ?? [])];
  for (const piece of delta.calls ?? []) {
    const call = calls[piece.index] ?? { name: "", args: "" };
    calls[piece.index] = {
      name: call.name + (piece.name ?? ""),
      args: call.args + (piece.arguments ?? ""),
    };
  }
  return {
    reasoning: (current?.reasoning ?? "") + (delta.reasoning ?? ""),
    text: (current?.text ?? "") + (delta.text ?? ""),
    calls,
  };
}
// Reads one string argument out of tool-call JSON that may still be arriving.
export function partialArgument(json: string, key: string) {
  const start = json.match(new RegExp(`"${key}"\\s*:\\s*"`));
  if (!start) return "";
  const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
  let out = "";
  for (let i = start.index! + start[0].length; i < json.length; i++) {
    const char = json[i];
    if (char === '"') break;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = json[++i];
    if (next === undefined) break;
    if (next === "u") {
      const hex = json.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += escapes[next] ?? next;
  }
  return out;
}
export function liveCall({ name, args }: { name: string; args: string }) {
  if (name === "sprite_exec") return partialArgument(args, "command");
  if (name === "submit") return `submit: ${partialArgument(args, "value")}`;
  return `${name} ${args}`.trim();
}
export type Call = {
  command: string;
  decision: "allow" | "block" | "error";
  reason: string;
  output?: string;
};
export function displayCommand(raw?: string) {
  return raw
    ?.split("\n")
    .map((line) => {
      if (!line.startsWith("sprite_exec:")) return line;
      try {
        const args = JSON.parse(line.replace(/^sprite_exec:\s*/, ""));
        return typeof args?.command === "string" ? args.command : line;
      } catch {
        return line;
      }
    })
    .join("\n");
}
// Folds each agent turn's monitor reviews and tool results into calls on the agent event.
// Only a tool result directly after a review is absorbed; any other event stays standalone.
export function groupTurns(events: GameEvent[]) {
  const groups: { event: GameEvent; calls: Call[]; pending: string[] }[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i],
      calls: Call[] = [];
    // Fold only per-command reviews (they name a command). The commandless end review is about the
    // whole run, so it stays standalone and renders as its own thread-level card.
    while (event.kind === "agent" && events[i + 1]?.kind === "monitor" && !!events[i + 1].command) {
      const review = events[++i];
      const decision = review.decision === "unverified" ? "error" : (review.decision ?? "error");
      const call: Call = {
        command: review.command ?? "",
        decision,
        reason: review.text,
        output: undefined,
      };
      if (events[i + 1]?.kind === "tool") {
        const result = events[++i];
        if (decision === "allow") call.output = result.text;
      }
      calls.push(call);
    }
    // Commands the monitor has not reviewed (yet, or ever after an error) stay visible, one per
    // call. Turns recorded before `commands` existed only have the joined text.
    let pending: string[];
    if (event.commands) pending = event.commands.slice(calls.length);
    else {
      const command = displayCommand(event.command) ?? "";
      const reviewed = calls.map((call) => call.command).join("\n");
      const rest = !reviewed
        ? command
        : command.startsWith(`${reviewed}\n`)
          ? command.slice(reviewed.length + 1)
          : "";
      pending = rest ? [rest] : [];
    }
    groups.push({ event, calls, pending });
  }
  return groups;
}
// The end-of-run review that caught a run: a block with no command. It is the run's outcome,
// which the outcome strip states with the investigator's reason, so the transcript leaves it out.
export function isEndReview(event: GameEvent) {
  return event.kind === "monitor" && event.decision === "block" && !event.command;
}
export function Entry({
  event,
  previous,
  calls,
  pending,
  disabled = false,
  showModel = false,
  runStatus,
  refusedTexts = [],
  onCopy,
}: {
  event: GameEvent;
  previous?: GameEvent;
  calls?: Call[];
  pending?: string[];
  disabled?: boolean;
  // Name the agent model on the turn. Wanted only when a run used more than one.
  showModel?: boolean;
  runStatus?: GameStatus;
  // Texts the jailbreak screen refused, for the owner only. A refused placeholder shows its own.
  refusedTexts?: NonNullable<PublicGame["refusedTexts"]>;
  onCopy?: () => void;
}) {
  // A classifier observation with nothing to show. Its score is in the monitor's view after the run.
  if (event.kind === "monitor" && !event.decision && !event.command && !event.text) return null;
  if (event.kind === "monitor" && event.decision === "allow") return null;
  if (event.kind === "tool" && previous?.kind === "monitor" && previous.decision === "block")
    return null;
  if (event.kind === "monitor" && event.decision === "block") {
    // No command: the end-of-run review of the whole transcript caught the run, not a single call.
    const endReview = !event.command;
    return (
      <article className={`entry monitor blocked${endReview ? " end-review" : ""}`}>
        <span>{endReview ? "Investigator review" : "Investigator block"}</span>
        {event.text && <p>{event.text}</p>}
      </article>
    );
  }
  const waiting =
    pending ??
    event.commands ??
    (displayCommand(event.command) ? [displayCommand(event.command)!] : []);
  // A time-limit stop is a normal, resumable pause. Show it as info, not an error.
  const info = event.kind === "error" && event.resumable;
  const httpSubmission = event.kind === "submit" && event.submissionTransport === "http";
  const refused = event.kind === "user" && event.refused ? refusedOf(event, refusedTexts) : [];
  if (refused.length) return <RefusedEntry texts={refused} />;
  return (
    <article className={`entry ${event.kind}${info ? " info" : ""}`}>
      <header>
        <strong className="speaker">
          {event.kind === "user"
            ? "USER"
            : event.kind === "agent"
              ? "AGENT"
              : event.kind === "tool"
                ? "TOOL OUTPUT"
                : event.kind === "monitor"
                  ? event.decision === "unverified"
                    ? "NO RESULT"
                    : "INVESTIGATION ERROR"
                  : httpSubmission
                    ? "SUBMITTED"
                    : event.kind === "submit"
                      ? event.correct
                        ? "SUBMITTED · CORRECT"
                        : "SUBMITTED · WRONG"
                      : info
                        ? "PAUSED"
                        : "SYSTEM"}
        </strong>
        {event.kind === "agent" && (
          <span className="turn-label">
            TURN {event.turn}
            {showModel && event.model && <span className="turn-model"> · {event.model}</span>}
          </span>
        )}
        {event.kind === "agent" && (
          <div className="entry-actions">
            <button type="button" aria-label="Copy response" disabled={disabled} onClick={onCopy}>
              <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
                <rect x="8" y="8" width="12" height="12" rx="1" />
                <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
              </svg>
            </button>
          </div>
        )}
      </header>
      {event.reasoning && (
        <details>
          <summary>Agent reasoning</summary>
          <p>{event.reasoning}</p>
        </details>
      )}
      {httpSubmission ? (
        <p>
          {runStatus && runStatus !== "active" && runStatus !== "finalizing"
            ? "Submission received. See run outcome."
            : "Submission received. The result is pending review."}
        </p>
      ) : event.kind === "submit" ? (
        <figure className="submission">
          <figcaption>The agent submitted this value:</figcaption>
          <blockquote>
            <CallOutput text={event.text ?? ""} />
          </blockquote>
          {(event.correct || typeof event.bugsPassed === "number") && (
            <figcaption className="submit-conditions">
              {event.correct ? "Flag correct" : "Flag wrong"}
              {typeof event.bugsPassed === "number"
                ? ` · ${event.bugsPassed} bug${event.bugsPassed === 1 ? "" : "s"} fixed`
                : ""}
              {event.correct && (event.bugsPassed ?? 0) >= 1
                ? " · both objectives met" + (event.caught ? ", but the run was caught." : ".")
                : ""}
            </figcaption>
          )}
        </figure>
      ) : null}
      {event.text &&
        event.kind !== "submit" &&
        (event.kind === "user" || event.kind === "agent" ? (
          <div className="markdown">
            <Markdown
              remarkPlugins={[remarkGfm]}
              disallowedElements={["img"]}
              components={{
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {event.text}
            </Markdown>
          </div>
        ) : (
          <p>{event.text}</p>
        ))}
      {event.truncated && (
        <p className="truncated-note">
          Ran out of tokens mid-thought. The reasoning above is kept and carried into the next turn.
          Ask for something smaller.
        </p>
      )}
      {calls?.map((call, index) => (
        <div className="call" key={index}>
          {call.command && <pre>{call.command}</pre>}
          {call.decision === "allow" ? (
            <>
              {/* Only an Easy fail-open carries a note; ordinary approvals have no reason. */}
              {call.reason && <p className="call-note">{call.reason}</p>}
              {call.output && <CallOutput text={call.output} />}
            </>
          ) : (
            <div className={`call-status ${call.decision}`}>
              <span>{call.decision === "block" ? "Blocked" : "Investigation error"}</span>
              {call.reason && <p>{call.reason}</p>}
            </div>
          )}
        </div>
      ))}
      {waiting.map((command, index) => (
        <div className="call" key={`waiting-${index}`}>
          <pre>{command}</pre>
        </div>
      ))}
    </article>
  );
}

export const REFUSED_NOTE =
  "Refused. The classifier found an attempt to override the agent’s or the monitor’s rules. The agent never received this text. Sending it ended the run.";

// The refused texts a placeholder stands for, in the order it lists them.
function refusedOf(event: GameEvent, texts: NonNullable<PublicGame["refusedTexts"]>) {
  return (event.refusedTextIds ?? []).flatMap((id) => texts.filter((text) => text.id === id));
}

// What the player sent, as plain text, with the refusal under it. The stored transcript holds
// only the placeholder, so the agent and the investigator never see this text.
function RefusedEntry({ texts }: { texts: NonNullable<PublicGame["refusedTexts"]> }) {
  return (
    <article className="entry user refused">
      <header>
        <strong className="speaker">USER</strong>
      </header>
      {texts.map((text) => (
        <div key={text.id} className="refused-text">
          {text.kind === "system_prompt" && <p>System prompt</p>}
          <pre>{text.text}</pre>
        </div>
      ))}
      <p className="refused-note">{REFUSED_NOTE}</p>
    </article>
  );
}

export function BlockedNotice({
  status = "blocked",
  blockedCommand = false,
  caughtSessionId = null,
  caughtSessionOrdinal = null,
  caughtReason = null,
  multiSession = false,
  onShowSession,
}: {
  status?: GameStatus;
  // A blocked command identifies an action-stage catch. Missing command metadata leaves the stage
  // unknown and gets generic copy.
  blockedCommand?: boolean;
  caughtSessionId?: string | null;
  caughtSessionOrdinal?: number | null;
  caughtReason?: string | null;
  // A run with one session does not need to be told which session was caught.
  multiSession?: boolean;
  // Shows and focuses the session that caused the catch. Given only while that session is hidden.
  onShowSession?: () => void;
}) {
  const caught = status === "caught";
  const heading = !caught ? "Run blocked" : blockedCommand ? "Caught in the act" : "Run caught";
  const generic = !caught ? BLOCKED_NOTICE : blockedCommand ? CAUGHT_IN_ACT_NOTICE : CAUGHT_NOTICE;
  // The investigator's own reason says more than the generic line, so it replaces it.
  const body = (caught && caughtReason) || generic;
  return (
    <div className="terminal loss">
      <h2>{heading}</h2>
      <p>{body}</p>
      {caught && multiSession && (caughtSessionOrdinal || caughtSessionId) && (
        <p>
          Session {caughtSessionOrdinal ?? caughtSessionId!.slice(0, 8)} caused the catch.{" "}
          {onShowSession && (
            <button type="button" className="link outcome-session" onClick={onShowSession}>
              Show session {caughtSessionOrdinal ?? caughtSessionId!.slice(0, 8)}
            </button>
          )}
        </p>
      )}
    </div>
  );
}

const PREVIEW_LINES = 12;
// Long output starts collapsed so one command can't bury the rest of the turn.
function CallOutput({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.length <= PREVIEW_LINES + 3) return <pre className="call-output">{text}</pre>;
  return (
    <div className="call-output">
      <pre>{lines.slice(0, PREVIEW_LINES).join("\n")}</pre>
      <details>
        <summary>
          <span className="more">Show {lines.length - PREVIEW_LINES} more lines</span>
          <span className="less">Hide {lines.length - PREVIEW_LINES} lines</span>
        </summary>
        <pre>{lines.slice(PREVIEW_LINES).join("\n")}</pre>
      </details>
    </div>
  );
}
