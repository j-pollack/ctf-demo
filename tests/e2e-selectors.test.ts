import assert from "node:assert/strict";
import { test } from "node:test";
import { e2eSources, stripSource } from "./e2e/source";

// The browser stories find elements by test id only, so a copy edit cannot fail one.
const BANNED_CALLS = [
  "getByRole",
  "getByLabel",
  "getByText",
  "getByPlaceholder",
  "getByTitle",
  "getByAltText",
  "locator",
  "frameLocator",
  "waitForSelector",
  "\\$eval",
  "\\$\\$eval",
  "\\$",
  "\\$\\$",
];
// Page-level forms that take a selector. The same names on a locator take none or an options object.
const SELECTOR_CALLS = [
  "click",
  "hover",
  "check",
  "dblclick",
  "textContent",
  "innerText",
  "inputValue",
  "isVisible",
];
const PATTERNS = [
  ...BANNED_CALLS.map((name) => ({ pattern: new RegExp(`\\.${name}\\s*\\(`, "g"), what: name })),
  ...SELECTOR_CALLS.map((name) => ({
    pattern: new RegExp(`\\.${name}\\s*\\(\\s*[^\\s){]`, "g"),
    what: `${name} with a selector`,
  })),
  { pattern: /\bgetByTestId\s*\(\s*[^\s"']/g, what: "getByTestId without a literal string" },
];

export function findBanned(source: string) {
  const code = stripSource(source);
  return PATTERNS.flatMap(({ pattern, what }) =>
    [...code.matchAll(pattern)].map((match) => ({
      line: code.slice(0, match.index).split("\n").length,
      what: what.replace(/\\/g, ""),
    })),
  );
}

test("the guard names each banned call with its line", () => {
  const cases: [string, string][] = [
    ['page.getByRole("button")', "getByRole"],
    ['page.getByLabel("Name")', "getByLabel"],
    ['page.getByText("x")', "getByText"],
    ['page.getByPlaceholder("x")', "getByPlaceholder"],
    ['page.getByTitle("x")', "getByTitle"],
    ['page.getByAltText("x")', "getByAltText"],
    ['page.locator("form")', "locator"],
    ['row.locator("option")', "locator"],
    ['page.frameLocator("iframe")', "frameLocator"],
    ['await page.waitForSelector("h1")', "waitForSelector"],
    ['await page.$("h1")', "$"],
    ['await page.$$("h1")', "$$"],
    ['await page.$eval("h1", (e) => e)', "$eval"],
    ['await page.$$eval("h1", (e) => e)', "$$eval"],
    ['await page.click("button")', "click with a selector"],
    ["await page.hover(selector)", "hover with a selector"],
    ['await page.check("input")', "check with a selector"],
    ['await page.dblclick("a")', "dblclick with a selector"],
    ['await page.textContent("h1")', "textContent with a selector"],
    ['await page.innerText("h1")', "innerText with a selector"],
    ['await page.inputValue("input")', "inputValue with a selector"],
    ['await page.isVisible("h1")', "isVisible with a selector"],
    ["page.getByTestId(`x-${id}`)", "getByTestId without a literal string"],
    ["page.getByTestId(id)", "getByTestId without a literal string"],
  ];
  for (const [code, what] of cases)
    assert.deepEqual(findBanned(`const a = 1;\n${code};`), [{ line: 2, what }], code);
});

test("the guard lets the allowed forms and comments through", () => {
  const allowed = [
    'await page.getByTestId("x").fill("a");',
    'await page.getByTestId("x").selectOption("monitor");',
    'await page.getByTestId("x").getAttribute("aria-checked");',
    'page.getByTestId("row").filter({ hasText: message });',
    'await page.getByTestId("x").click();',
    'await page.getByTestId("x").click({ force: true });',
    'await page.getByTestId("x").inputValue();',
    'await page.getByTestId("x").isVisible();',
    "await page.getByTestId('x').textContent();",
    'await page.request.get("/api/auth/get-session");',
    'await page.request.post("/api/auth/sign-in/magic-link", { data });',
    'await page.goto("/admin");',
    'const text = "getByRole is only a word here";',
    "// page.getByRole('button') in a line comment",
    '/* page.locator("form")\n   page.getByText("x") */',
    'await page.goto("https://example.test/a"); // page.$("h1")',
  ];
  for (const code of allowed) assert.deepEqual(findBanned(code), [], code);
});

test("the stories use only the allowed calls", () => {
  const found = e2eSources().flatMap(({ file, source }) =>
    findBanned(source).map(({ line, what }) => `${file}:${line} ${what}`),
  );
  assert.deepEqual(found, []);
});
