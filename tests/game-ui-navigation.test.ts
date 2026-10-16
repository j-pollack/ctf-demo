import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canCreateNewRun,
  hasActiveRun,
  lastEventId,
  selectedNavItem,
  shouldPoll,
  withEarlierEvents,
} from "../app/game-ui";
import type { PublicGame } from "../lib/types";

const game = (overrides: Partial<PublicGame> = {}) =>
  ({
    id: "run",
    status: "active",
    events: [],
    season: {
      id: "season",
      name: "Season",
      startsAt: null,
      endsAt: "2030-01-01T00:00:00Z",
      monitorModel: "monitor/model",
    },
    ...overrides,
  }) as PublicGame;

const now = Date.parse("2026-10-02T00:00:00Z");

test("navigation selection follows canonical route and whether a detail can continue", () => {
  const continuable = game();
  const cases: [string, PublicGame | null | undefined, string | null][] = [
    ["/play", null, "play"],
    ["/runs", continuable, "history"],
    ["/rank", null, "rank"],
    ["/rules", null, "rules"],
    ["/runs/run", continuable, "play"],
    ["/runs/run", { ...continuable, busy: true }, "play"],
    ["/runs/run", undefined, null],
    ["/runs/run", null, null],
    ["/runs/run", { ...continuable, status: "ended" }, null],
    ["/runs/run", { ...continuable, status: "captured" }, null],
    ["/runs/run", { ...continuable, status: "exhausted" }, null],
    ["/runs/run", { ...continuable, status: "creating" }, null],
    [
      "/runs/run",
      { ...continuable, season: { ...continuable.season, endsAt: "2026-10-01T00:00:00Z" } },
      null,
    ],
  ];
  for (const [path, detail, expected] of cases)
    assert.equal(selectedNavItem(path, detail, now), expected, `${path} with ${detail?.status}`);
});

test("an empty continuable current run cannot be replaced, but a used or ended run can", () => {
  assert.equal(canCreateNewRun(undefined, now, false), false);
  assert.equal(canCreateNewRun(null, now), true);
  assert.equal(canCreateNewRun(game(), now), false);
  assert.equal(canCreateNewRun(game(), now, true), false);
  assert.equal(
    canCreateNewRun(game({ events: [{ id: 1, kind: "user", text: "go" }] }), now, true),
    true,
  );
  assert.equal(
    canCreateNewRun(game({ events: [{ id: -1, kind: "user", text: "optimistic" }] }), now),
    false,
  );
  assert.equal(canCreateNewRun(game({ status: "ended" }), now), true);
  assert.equal(
    canCreateNewRun(
      game({
        season: {
          id: "season",
          name: "Season",
          startsAt: null,
          endsAt: "2026-10-02T00:00:00Z",
          monitorModel: "monitor/model",
        },
      }),
      now,
    ),
    true,
  );
});

test("polling follows live work, not pending billing", () => {
  // A run whose billing hold never settles must not be re-fetched forever.
  assert.equal(shouldPoll(game({ reservedMicrodollars: 36518 }), false, false), false);
  assert.equal(
    shouldPoll(game({ reservedMicrodollars: 36518, status: "ended" }), false, false),
    false,
  );
  assert.equal(shouldPoll(game({ busy: true }), false, false), true);
  assert.equal(shouldPoll(game(), false, true), true);
  // The prompt stream already delivers updates while this tab drives the turn.
  assert.equal(shouldPoll(game({ busy: true }), true, true), false);
});

test("delta polls keep held events and append only newer ones", () => {
  const held = [
    { id: 4, kind: "user" as const, text: "go" },
    { id: 7, kind: "agent" as const, text: "thinking" },
    { id: -1, kind: "user" as const, text: "optimistic" },
  ];
  assert.equal(lastEventId(held), 7);
  assert.equal(lastEventId([]), 0);
  const delta = game({ events: [{ id: 9, kind: "tool", text: "ok" }], turns: 2 });
  const merged = withEarlierEvents(held, delta, 7);
  assert.deepEqual(
    merged.events.map((event) => event.id),
    [4, 7, 9],
  );
  assert.equal(merged.turns, 2, "run fields come from the fresh response");
});

test("Play opens the new-run dialog unless a run can still be continued", () => {
  assert.equal(hasActiveRun(null, now), false);
  assert.equal(hasActiveRun(undefined, now), false);
  assert.equal(hasActiveRun(game(), now), true);
  for (const status of ["captured", "exhausted", "ended", "creating"] as const)
    assert.equal(hasActiveRun(game({ status }), now), false, status);
  const expired = game();
  expired.season = { ...expired.season, endsAt: "2026-10-01T00:00:00Z" };
  assert.equal(hasActiveRun(expired, now), false);
});
