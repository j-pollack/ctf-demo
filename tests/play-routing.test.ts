import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function pageRoutes(directory: string, segments: string[] = []): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return pageRoutes(
        join(directory, entry.name),
        /^\(.*\)$/.test(entry.name) ? segments : [...segments, entry.name],
      );
    }
    return entry.name === "page.tsx" ? ["/" + segments.join("/")] : [];
  });
}

test("public landing and grouped play have unique routes, sharing history's game layout", () => {
  const app = new URL("../app", import.meta.url).pathname;
  const routes = pageRoutes(app);
  assert.equal(routes.filter((route) => route === "/").length, 1);
  assert.equal(routes.filter((route) => route === "/play").length, 1);
  assert.ok(pageRoutes(join(app, "(game)")).includes("/play"));
  for (const route of ["/runs", "/runs/[id]", "/rank", "/rules"]) assert.ok(routes.includes(route));
});
