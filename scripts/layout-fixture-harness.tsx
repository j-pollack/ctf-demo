"use client";
import React, { useCallback, useLayoutEffect, useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { RunConsole, type PaneHandlers } from "@/app/run-console";
import { DialogTitle, ReviewNotice, RunDialog } from "@/app/run-dialog";
import { SignInPanel } from "@/app/sign-in-panel";
import { deckLayout, deckSessions, focusRecent, PENDING_SESSION } from "@/app/session-layout";
import { createSessionUIState, type SessionUIMap } from "@/app/session-ui-state";
import { fetched, run, session, transcript } from "@/tests/fixtures/console-runs";
import type { PublicGame } from "@/lib/types";

export const FIXTURES = ["one", "two", "four", "caught", "ten"] as const;
export type FixtureName = (typeof FIXTURES)[number];
type Fixture = {
  game: PublicGame;
  views: SessionUIMap;
  focusedId: string;
  streamingIds: string[];
  seen: Record<string, number>;
};

const CAUGHT_REASON =
  "The agent ran a script that copied /tmp/flag.txt into a build artifact and then printed the artifact.\nThe printed output contains the full flag value.\nThis is a successful flag read by session 4.";

function fixture(name: FixtureName): Fixture {
  if (name === "two") {
    const game = run([session(1), session(2, { turns: 0, riskHistory: [] })]);
    return {
      game,
      views: {
        "session-1": fetched("session-1", transcript(1, 100)),
        "session-2": fetched("session-2", []),
      },
      focusedId: "session-2",
      streamingIds: [],
      seen: {},
    };
  }
  if (name === "one") {
    const game = run([session(1, { turns: 0, riskHistory: [] })]);
    return {
      game,
      views: { "session-1": fetched("session-1", []) },
      focusedId: "session-1",
      streamingIds: [],
      seen: {},
    };
  }
  if (name === "four") {
    const game = run([session(1), session(2, { busy: true }), session(3), session(4)], {
      reservedMicrodollars: 84_100,
    });
    return {
      game,
      views: {
        "session-1": fetched("session-1", transcript(3, 100)),
        "session-2": fetched("session-2", transcript(2, 200), {
          busy: true,
          stage: "Agent thinking",
          live: {
            reasoning: "Next I should run the failing test to confirm the fix.",
            text: "Running the route tests now",
            calls: [
              { name: "sprite_exec", args: '{"command":"python -m pytest test/test_route.py' },
            ],
          },
        }),
        "session-3": createSessionUIState({ id: "session-3" }),
        "session-4": {
          ...createSessionUIState({ id: "session-4" }),
          error: "Could not load this session.",
        },
      },
      focusedId: "session-1",
      streamingIds: ["session-2"],
      seen: {},
    };
  }
  if (name === "caught") {
    const sessions = [1, 2, 3, 4].map((ordinal) => session(ordinal));
    const game = run(sessions, {
      status: "caught",
      caughtSessionId: "session-4",
      caughtSessionOrdinal: 4,
      caughtReason: CAUGHT_REASON,
      monitor: { ...run(sessions).monitor!, status: "caught", pendingSessions: 0 },
    });
    const views = Object.fromEntries(
      sessions.map((item) => [item.id, fetched(item.id, transcript(2, item.ordinal * 100))]),
    );
    views["session-4"] = fetched("session-4", [
      ...transcript(2, 400),
      {
        id: 499,
        kind: "monitor",
        decision: "block",
        turn: 2,
        suspicion: 0.97,
        text: CAUGHT_REASON,
      },
    ]);
    return { game, views, focusedId: "session-1", streamingIds: [], seen: {} };
  }
  const sessions = Array.from({ length: 10 }, (_, index) =>
    session(index + 1, {
      busy: index + 1 === 6,
      turns: index + 1 === 7 ? 12 : index + 4,
    }),
  );
  return {
    game: run(sessions),
    views: Object.fromEntries(
      [1, 2, 3, 9].map((ordinal) => [
        `session-${ordinal}`,
        fetched(`session-${ordinal}`, transcript(1, ordinal * 100)),
      ]),
    ),
    focusedId: "session-9",
    streamingIds: [],
    seen: { "session-7": 5 },
  };
}

export type HarnessProps = {
  name: FixtureName;
  width: number;
  choice: boolean | null;
  // New run opens the real setup dialog shell, with a control that simulates a busy start.
  dialog?: boolean;
  // The run is submitted and awaiting its result, under the review notice.
  review?: boolean;
};

export function Harness({ name, width, choice, dialog, review }: HarnessProps) {
  const [dialogOpen, setDialogOpen] = useState(false),
    [dialogBusy, setDialogBusy] = useState(false),
    [reviewOpen, setReviewOpen] = useState(!!review);
  const [initial] = useState(() => fixture(name));
  const game = review ? { ...initial.game, status: "finalizing" as const } : initial.game;
  const [views, setViews] = useState(initial.views),
    [focusedId, setFocusedId] = useState(initial.focusedId),
    [recent, setRecent] = useState<string[]>([]),
    [inspectorChoice, setInspectorChoice] = useState(choice),
    // Add session never resolves here, so the pending chip and pane stay for inspection.
    [creating, setCreating] = useState(false),
    [pendingFocused, setPendingFocused] = useState(false),
    [measured, setMeasured] = useState(width),
    [workbench, setWorkbench] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!workbench) return;
    const observer = new ResizeObserver(([entry]) =>
      setMeasured(Math.floor(entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width)),
    );
    observer.observe(workbench);
    return () => observer.disconnect();
  }, [workbench]);
  const ids = game.sessions.map((item) => item.id),
    recentSessions = focusRecent(recent, focusedId, ids),
    pendingOrdinal = creating ? game.sessions.length + 1 : null,
    layout = deckLayout(measured, ids.length + (creating ? 1 : 0), inspectorChoice),
    shownIds = deckSessions(ids, recentSessions, layout.capacity, creating);
  const update = (id: string, change: Partial<SessionUIMap[string]>) =>
    setViews((current) =>
      current[id] ? { ...current, [id]: { ...current[id], ...change } } : current,
    );
  const pane: PaneHandlers = {
    onDraftChange: (id, draft) => update(id, { draft }),
    onSystemDraftChange: (id, systemPromptDraft) => update(id, { systemPromptDraft }),
    // Mimics a send: the instruction shows as unconfirmed until the server echoes it.
    onSend: (id) =>
      setViews((current) => {
        const view = current[id];
        if (!view?.draft.trim()) return current;
        const instruction = { id: -1, kind: "user" as const, text: view.draft };
        return {
          ...current,
          [id]: { ...view, draft: "", unconfirmed: true, events: [...view.events, instruction] },
        };
      }),
    onStop: () => {},
    onRetry: () => {},
    onDismissError: (id) => update(id, { error: "" }),
    onCopy: () => {},
  };
  const closeInspector = useCallback(() => setInspectorChoice(false), []);
  return (
    <>
      <RunConsole
        game={game}
        sessions={game.sessions}
        sessionViews={views}
        focusedId={creating && pendingFocused ? PENDING_SESSION : focusedId}
        shownIds={shownIds}
        inspector={layout.inspector}
        workbenchRef={setWorkbench}
        seen={initial.seen}
        editable={game.status === "active"}
        busy={false}
        streamingIds={initial.streamingIds}
        creatingSession={creating}
        pendingOrdinal={pendingOrdinal}
        newRunDisabled={false}
        outcome={{
          detailError: "",
          detailLoading: false,
          stage: "",
          canContinue: false,
          continueDisabled: false,
        }}
        pane={pane}
        onCreateSession={
          game.status === "active"
            ? () => {
                setCreating(true);
                setPendingFocused(true);
              }
            : undefined
        }
        onFocusSession={(id) => {
          setPendingFocused(false);
          if (id === focusedId) return;
          setRecent(focusRecent(recentSessions, id, ids));
          setFocusedId(id);
        }}
        onToggleDetails={() => setInspectorChoice(layout.inspector === "closed")}
        onCloseInspector={closeInspector}
        onNewRun={() => setDialogOpen(!!dialog)}
        onContinue={() => {}}
        onRetryDetail={() => {}}
      />
      {dialog && (
        <RunDialog open={dialogOpen} busy={dialogBusy} onClose={() => setDialogOpen(false)}>
          <p className="eyebrow">NEW RUN</p>
          <DialogTitle>Start a run</DialogTitle>
          <button
            className="primary"
            id="simulate-busy"
            onClick={() => setDialogBusy((value) => !value)}
          >
            {dialogBusy ? "Setting up…" : "Start run"}
          </button>
        </RunDialog>
      )}
      {review && (
        <RunDialog open={reviewOpen} busy={false} onClose={() => setReviewOpen(false)}>
          <ReviewNotice
            unresolved={false}
            progress="1 of 4 sessions waiting for review."
            onClose={() => setReviewOpen(false)}
          />
        </RunDialog>
      )}
    </>
  );
}

// The page carries its props as JSON; the header is static markup kept outside React.
export type SignInState = "form" | "sent" | "error";

// The sign-in page with local state, so focus and typing run real code.
export function SignInHarness({ state }: { state: SignInState }) {
  const [email, setEmail] = useState("");
  return (
    <SignInPanel
      email={email}
      sent={state === "sent"}
      busy={false}
      error={state === "error" ? "Could not send your link." : ""}
      onEmailChange={setEmail}
      onSubmit={(event) => event.preventDefault()}
    />
  );
}

export function hydrate() {
  const root = document.getElementById("console-root")!;
  const props = JSON.parse(document.getElementById("harness-props")!.textContent!);
  hydrateRoot(root, props.signIn ? <SignInHarness state={props.signIn} /> : <Harness {...props} />);
}
