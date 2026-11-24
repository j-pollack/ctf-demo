// Renders the play console from fixtures with the real stylesheet, for browser measurement.
// Usage: node --import tsx scripts/layout-fixture.tsx   Writes .artifacts/layout/*.html
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { build } from "esbuild";
import SiteHeader from "@/app/site-header";
import { LeaderboardPanel, RulesPanel, RunHistoryRow } from "@/app/game-ui";
import {
  FIXTURES,
  Harness,
  SignInHarness,
  type HarnessProps,
  type SignInState,
} from "./layout-fixture-harness";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".artifacts/layout");
const WIDTHS = [390, 1024, 1440, 1728];
const GUTTER = 24;
const NARROW_GUTTER = 12;
const NARROW = 720;

const workbenchWidth = (viewport: number) =>
  viewport - 2 * (viewport <= NARROW ? NARROW_GUTTER : GUTTER);

async function clientBundle() {
  const result = await build({
    stdin: {
      contents: 'import { hydrate } from "./layout-fixture-harness"; hydrate();',
      resolveDir: join(root, "scripts"),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    minify: true,
    format: "iife",
    jsx: "automatic",
    tsconfig: join(root, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  });
  return result.outputFiles[0].text.replaceAll("</script", "<\\/script");
}

function page(props: HarnessProps, css: string, script: string) {
  const header = renderToStaticMarkup(<SiteHeader current="play" onPlay={() => {}} />);
  const console = renderToString(<Harness {...props} />);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Layout fixture ${props.name}</title><style>${css}</style></head>
<body><div class="app"><div class="workspace">${header}<div id="console-root" style="display:contents">${console}</div></div></div>
<script type="application/json" id="harness-props">${JSON.stringify(props)}</script>
<script>${script}</script></body></html>`;
}

function signInPage(state: SignInState, css: string, script: string) {
  const header = renderToStaticMarkup(<SiteHeader current={null} onPlay={() => {}} />);
  const body = renderToString(<SignInHarness state={state} />);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Layout fixture sign-in ${state}</title><style>${css}</style></head>
<body><div class="app"><div class="workspace">${header}<div id="console-root" style="display:contents">${body}</div></div></div>
<script type="application/json" id="harness-props">${JSON.stringify({ signIn: state })}</script>
<script>${script}</script></body></html>`;
}

const noop = () => {};
const SCORES = Array.from({ length: 8 }, (_, index) => ({
  name: `Operator ${index + 1}`,
  turns: 6 + index * 3,
  tokens: 48_000 + index * 9_250,
  spend: 41_000 + index * 17_300,
}));
const RUNS = (["captured", "caught", "exhausted", "ended", "active"] as const).map(
  (status, index) => ({
    id: `${index}7eea982-6c1f-4f7e-9d55-0d1f6a2b7c10`,
    status,
    agentModel: index === 2 ? null : "z-ai/glm-5.3-flash",
    monitorDifficulty: "medium" as const,
    turns: 4 + index * 5,
    blocks: 0,
    budgetMicrodollars: 500_000,
    spentMicrodollars: 120_000 + index * 61_000,
    reservedMicrodollars: index === 4 ? 21_000 : 0,
    createdAt: "2026-11-14T10:00:00.000Z",
  }),
);
// The My Runs and run detail markup mirrors GameUI, which needs a router and a session.
const INFO_PAGES: Record<string, { nav: string; body: React.ReactNode }> = {
  rules: {
    nav: "rules",
    body: (
      <RulesPanel
        rules={{ monitorIsolation: false, bugFixRequired: true, jailbreakCatch: false }}
      />
    ),
  },
  rank: {
    nav: "rank",
    body: (
      <LeaderboardPanel
        scores={SCORES}
        models={["z-ai/glm-5.3-flash"]}
        boardAgent=""
        onAgentChange={noop}
      />
    ),
  },
  runs: {
    nav: "history",
    body: (
      <main className="info run-history">
        <p className="eyebrow">PRIVATE TO YOUR ACCOUNT</p>
        <h2>My runs</h2>
        <p className="empty">Your runs are saved to your account.</p>
        <div className="run-list">
          {RUNS.map((run) => (
            <RunHistoryRow key={run.id} run={run} onOpen={noop} />
          ))}
        </div>
      </main>
    ),
  },
  "runs-error": {
    nav: "history",
    body: (
      <main className="info run-history">
        <p className="eyebrow">PRIVATE TO YOUR ACCOUNT</p>
        <h2>My runs</h2>
        <p className="empty">Your runs are saved to your account.</p>
        <div role="alert" className="error">
          Could not load your runs.
          <button className="link">Retry</button>
        </div>
        <p role="status">Loading runs…</p>
      </main>
    ),
  },
  "run-missing": {
    nav: "history",
    body: (
      <main className="info run-detail">
        <button className="link">← All runs</button>
        <p className="empty">Run not found.</p>
      </main>
    ),
  },
};

function infoPage(name: string, css: string) {
  const { nav, body } = INFO_PAGES[name];
  const html = renderToStaticMarkup(
    <div className="app">
      <div className="workspace">
        <SiteHeader current={nav} onPlay={noop} />
        {body}
      </div>
    </div>,
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Layout fixture ${name}</title><style>${css}</style></head><body>${html}</body></html>`;
}

async function main() {
  mkdirSync(out, { recursive: true });
  const css = readFileSync(join(root, "app/globals.css"), "utf8");
  const script = await clientBundle();
  const files: string[] = [];
  const write = (file: string, props: HarnessProps) => {
    writeFileSync(join(out, file), page(props, css, script));
    files.push(file);
  };
  for (const name of FIXTURES)
    for (const viewport of WIDTHS)
      write(`${name}-${viewport}.html`, { name, width: workbenchWidth(viewport), choice: null });
  for (const viewport of WIDTHS)
    write(`four-${viewport}-inspector.html`, {
      name: "four",
      width: workbenchWidth(viewport),
      choice: true,
    });
  for (const viewport of [390, 1440])
    write(`dialog-${viewport}.html`, {
      name: "four",
      width: workbenchWidth(viewport),
      choice: true,
      dialog: true,
    });
  for (const viewport of [390, 1440])
    write(`review-${viewport}.html`, {
      name: "four",
      width: workbenchWidth(viewport),
      choice: null,
      review: true,
    });
  for (const state of ["form", "sent", "error"] as const) {
    writeFileSync(join(out, `signin-${state}.html`), signInPage(state, css, script));
    files.push(`signin-${state}.html`);
  }
  for (const name of Object.keys(INFO_PAGES)) {
    writeFileSync(join(out, `${name}.html`), infoPage(name, css));
    files.push(`${name}.html`);
  }
  console.log(files.map((file) => join(out, file)).join("\n"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
