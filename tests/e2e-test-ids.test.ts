import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { test } from "node:test";
import { e2eSources, stripSource } from "./e2e/source";

// Every id a story selects by has to be one the app renders, or a story waits on nothing.
type Source = { file: string; source: string };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A literal matches exactly. A template matches on its fixed parts, each interpolation standing
// for one or more characters.
const fromTemplate = (template: string) =>
  new RegExp(
    `^${template
      .split(/\$\{[^}]*\}/)
      .map(escape)
      .join(".+")}$`,
  );

export function appIds(sources: Source[]) {
  const literals: string[] = [];
  const patterns: RegExp[] = [];
  for (const { source } of sources) {
    const code = stripSource(source, true);
    for (const [, id] of code.matchAll(/data-testid="([^"]+)"/g)) literals.push(id);
    for (const [, id] of code.matchAll(/data-testid=\{\s*"([^"]+)"\s*\}/g)) literals.push(id);
    for (const [, template] of code.matchAll(/data-testid=\{\s*`([^`]*)`\s*\}/g))
      patterns.push(fromTemplate(template));
    for (const [, body] of code.matchAll(/\b\w*TEST_IDS\b[^=]*=\s*\{([^}]*)\}/g))
      for (const [, id] of body.matchAll(/"([^"]+)"/g)) literals.push(id);
  }
  return { literals, patterns };
}

// A literal id that a template also matches would stay "rendered" for this guard after the
// literal is deleted, so the two may not overlap.
export function shadowedIds(app: Source[]) {
  const { literals, patterns } = appIds(app);
  return [...new Set(literals)].filter((id) => patterns.some((pattern) => pattern.test(id)));
}

export function storyIds(sources: Source[]) {
  return sources.flatMap(({ source }) =>
    [...stripSource(source, true).matchAll(/getByTestId\(\s*["']([^"']+)["']/g)].map(
      (match) => match[1],
    ),
  );
}

export function unmatchedIds(stories: Source[], app: Source[]) {
  const { literals, patterns } = appIds(app);
  return [...new Set(storyIds(stories))].filter(
    (id) => !literals.includes(id) && !patterns.some((pattern) => pattern.test(id)),
  );
}

function appSources(dir = "app"): Source[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return appSources(path);
    return [".ts", ".tsx"].includes(extname(path))
      ? [{ file: path, source: readFileSync(path, "utf8") }]
      : [];
  });
}

const story = (code: string): Source[] => [{ file: "story.ts", source: code }];
const app = (code: string): Source[] => [{ file: "app.tsx", source: code }];

test("an id that nothing under app matches fails and is named", () => {
  assert.deepEqual(
    unmatchedIds(
      story('page.getByTestId("page-run"); page.getByTestId("page-runs");'),
      app('<div data-testid="page-runs" />'),
    ),
    ["page-run"],
  );
  assert.deepEqual(
    unmatchedIds(story('page.getByTestId("gone");'), app('<div data-testid="here" />')),
    ["gone"],
  );
});

test("page-run is not matched by page-runs or any longer id", () => {
  const stories = story('page.getByTestId("page-run");');
  for (const id of ["page-runs", "page-run-detail", "x-page-run"])
    assert.deepEqual(unmatchedIds(stories, app(`<div data-testid="${id}" />`)), ["page-run"], id);
});

test("an id a template, a braced literal or a TEST_IDS constant produces passes", () => {
  const code = [
    "const PAGE_TEST_IDS = { history: \"page-history\", rank: 'ignored' } as const;",
    "<form data-testid={`admin-rule-${key}`} />",
    '<b data-testid={"braced"} />',
    '// <i data-testid="commented" />',
  ].join("\n");
  const ids = ["page-history", "admin-rule-bug_fix_required", "braced", "commented", "admin-rule-"];
  const stories = story(ids.map((id) => `page.getByTestId("${id}");`).join("\n"));
  assert.deepEqual(unmatchedIds(stories, app(code)), ["commented", "admin-rule-"]);
});

test("a literal id that a template also matches is named", () => {
  const code =
    '<form data-testid={`a-${key}`}><b data-testid="a-b" /><i data-testid="c-d" /></form>';
  assert.deepEqual(shadowedIds(app(code)), ["a-b"]);
});

test("no literal id under app is also matched by a template", () => {
  assert.deepEqual(shadowedIds(appSources()), []);
});

test("every id the stories select by is rendered by the app", () => {
  assert.deepEqual(unmatchedIds(e2eSources(), appSources()), []);
});
