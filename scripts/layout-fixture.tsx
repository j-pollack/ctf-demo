// Renders the play console from fixtures with the real stylesheet, for browser measurement.
// Usage: node --import tsx scripts/layout-fixture.tsx   Writes .artifacts/layout/*.html
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { build } from "esbuild";
import SiteHeader from "@/app/site-header";
import { FIXTURES, Harness, type HarnessProps } from "./layout-fixture-harness";

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
  console.log(files.map((file) => join(out, file)).join("\n"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
