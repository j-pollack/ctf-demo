import { test } from "node:test";
import assert from "node:assert/strict";
import { hasRiskObservations, runRiskSeries, runPeakRisk } from "../app/run-risk";
import type { SessionSummary } from "../lib/types";
import type { SessionUIMap } from "../app/session-ui-state";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunRiskChart } from "../app/run-risk-chart";

const session = (id: string, ordinal: number, riskHistory: { turn: number; risk: number }[] = []) =>
  ({ id, ordinal, riskHistory }) as SessionSummary;
const local = (
  events: { id: number; kind: "monitor"; text: string; turn?: number; suspicion?: number }[],
) => ({ events, busy: false }) as SessionUIMap[string];

test("run peak includes an unvisited sibling and ignores foreign local views", () => {
  const sessions = [
    session("one", 1, [{ turn: 1, risk: 0.2 }]),
    session("two", 2, [{ turn: 2, risk: 0.91 }]),
  ];
  const views = { foreign: local([{ id: 10, kind: "monitor", text: "", turn: 2, suspicion: 1 }]) };
  const result = runRiskSeries(sessions, views);
  assert.equal(runPeakRisk(result), 0.91);
  assert.deepEqual(
    result.map((series) => series.ordinal),
    [1, 2],
  );
});

test("unreviewed runs are distinct from a measured zero-risk review", () => {
  assert.equal(hasRiskObservations(runRiskSeries([session("one", 1)], {})), false);
  assert.equal(
    hasRiskObservations(runRiskSeries([session("one", 1, [{ turn: 1, risk: 0 }])], {})),
    true,
  );
});

test("local monitor updates raise the run peak without losing persisted history or mutating inputs", () => {
  const history = [
    { turn: 1, risk: 0.8 },
    { turn: 3, risk: 0.4 },
  ];
  const sessions = [session("one", 1, history), session("two", 2)];
  const events = [
    { id: 4, kind: "monitor" as const, text: "", turn: 1, suspicion: 0.2 },
    { id: 5, kind: "monitor" as const, text: "", turn: 2, suspicion: 0.95 },
    { id: 6, kind: "monitor" as const, text: "", turn: 2, suspicion: 0.7 },
    { id: 7, kind: "monitor" as const, text: "", suspicion: 0.3 },
  ];
  const result = runRiskSeries(sessions, { one: local(events) });
  assert.deepEqual(result[0].points, [
    { turn: 0, risk: 0.3 },
    { turn: 1, risk: 0.8 },
    { turn: 2, risk: 0.95 },
    { turn: 3, risk: 0.4 },
  ]);
  assert.deepEqual(result[1].points, []);
  assert.equal(runPeakRisk(result), 0.95);
  assert.deepEqual(history, [
    { turn: 1, risk: 0.8 },
    { turn: 3, risk: 0.4 },
  ]);
  assert.equal(events.length, 4);
});

test("run risk chart overlays sessions on a shared turn axis without transcript links", () => {
  const html = renderToStaticMarkup(
    React.createElement(RunRiskChart, {
      series: [
        {
          id: "one",
          ordinal: 1,
          points: [
            { turn: 0, risk: 0.2 },
            { turn: 3, risk: 0.8 },
          ],
        },
        { id: "two", ordinal: 2, points: [{ turn: 2, risk: 0.9 }] },
        { id: "three", ordinal: 3, points: [] },
      ],
    }),
  );
  assert.match(html, /Run classifier risk by session and agent turn/);
  assert.match(html, /Session 1/);
  assert.match(html, /Session 2/);
  assert.match(html, /Session 3/);
  assert.match(html, /No risk data/);
  assert.match(html, /Session 1 · peak 80%/);
  assert.match(html, /Session 2 · peak 90%/);
  assert.match(html, /Pre-turn/);
  assert.match(html, /100%/);
  assert.match(html, /class="risk-trace"/);
  assert.match(html, /class="risk-point"/);
  assert.match(html, /stroke-dasharray="7 3"/);
  assert.match(html, /<rect[^>]*width="7"/);
  assert.match(html, /Agent turn per session/);
  assert.equal(html.includes("href="), false);
});

test("long run axis omits the crowded first-turn tick", () => {
  const html = renderToStaticMarkup(
    React.createElement(RunRiskChart, {
      series: [
        {
          id: "one",
          ordinal: 1,
          points: [
            { turn: 0, risk: 0.2 },
            { turn: 100, risk: 0.8 },
          ],
        },
      ],
    }),
  );
  const axisLabels = [...html.matchAll(/class="risk-axis"[^>]*>([^<]+)<\/text>/g)].map(
    (match) => match[1],
  );
  assert.ok(axisLabels.includes("Pre-turn"));
  assert.ok(axisLabels.includes("100"));
  assert.equal(axisLabels.includes("1"), false);
});

test("empty and single-point charts render labels and markers without invented traces", () => {
  const empty = renderToStaticMarkup(React.createElement(RunRiskChart, { series: [] }));
  assert.match(empty, /Run classifier risk/);
  assert.equal(empty.includes('class="risk-trace"'), false);
  const single = renderToStaticMarkup(
    React.createElement(RunRiskChart, {
      series: [{ id: "one", ordinal: 1, points: [{ turn: 2, risk: 0.6 }] }],
    }),
  );
  assert.match(single, /Session 1, turn 2: 60%/);
  assert.equal(single.includes('class="risk-trace"'), false);
});
