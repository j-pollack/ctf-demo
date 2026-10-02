import { test } from "node:test";
import assert from "node:assert/strict";
import { canCreateNewRun, selectedNavItem } from "../app/game-ui";
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
