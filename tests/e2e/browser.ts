import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { baseUrl, signInLink, takeServerFailures, takeViolations, visitorHeaders } from "./stack";

const EVIDENCE = ".artifacts/e2e";
export const TIMEOUT = 15_000;

export type Session = {
  page: Page;
  // Another browser context, with its own cookies, collected like the first.
  fresh: () => Promise<Page>;
  // A response the journey causes on purpose: left out of the failed-response check.
  expectFailure: (status: number, path: string) => void;
  // A failure event the journey makes the server log on purpose: left out of the log check.
  expectServerFailure: (event: string) => void;
};

type Tracked = { context: BrowserContext; page: Page; problems: string[] };

async function track(browser: Browser, expected: { status: number; path: string }[]) {
  const context = await browser.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: visitorHeaders(),
  });
  context.setDefaultTimeout(TIMEOUT);
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const problems: string[] = [];
  const isExpected = (url: string, status?: number) => {
    const { pathname } = new URL(url);
    return expected.some((item) => item.path === pathname && (!status || item.status === status));
  };
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Chromium reports a failed load as a console error too.
    if (isExpected(message.location().url || baseUrl)) return;
    problems.push(`console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("response", (response) => {
    const url = response.url();
    if (!url.startsWith(baseUrl) || response.status() < 400) return;
    if (!isExpected(url, response.status())) problems.push(`${response.status()} ${url}`);
  });
  page.on("requestfailed", (request) => {
    const error = request.failure()?.errorText ?? "";
    if (!error.includes("ERR_ABORTED")) problems.push(`request failed: ${request.url()} ${error}`);
  });
  return { context, page, problems } satisfies Tracked;
}

const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

// One journey: a fresh Chromium, every page collected for errors, and no violation left behind.
// A failing journey keeps its traces and screenshots under .artifacts/e2e.
export function journey(name: string, body: (session: Session) => Promise<void>) {
  return test(name, { timeout: 90_000 }, async () => {
    const browser = await chromium.launch();
    const expected: { status: number; path: string }[] = [];
    const expectedEvents: string[] = [];
    const tracked: Tracked[] = [await track(browser, expected)];
    const session: Session = {
      page: tracked[0].page,
      fresh: async () => {
        tracked.push(await track(browser, expected));
        return tracked[tracked.length - 1].page;
      },
      expectFailure: (status, path) => expected.push({ status, path }),
      expectServerFailure: (event) => expectedEvents.push(event),
    };
    try {
      await body(session);
      assert.deepEqual(
        tracked.flatMap((item) => item.problems),
        [],
        "the browser reported problems",
      );
      assert.deepEqual(takeViolations(), [], "the server recorded violations");
      const failures = takeServerFailures();
      assert.deepEqual(
        failures.map((entry) => entry.event),
        expectedEvents,
        `the server logged failures: ${JSON.stringify(failures)}`,
      );
    } catch (error) {
      // Violations and failures this journey caused must not fail the next one.
      for (const violation of takeViolations())
        console.error(`${name}: server violation ${JSON.stringify(violation)}`);
      for (const failure of takeServerFailures())
        console.error(`${name}: server failure ${JSON.stringify(failure)}`);
      mkdirSync(EVIDENCE, { recursive: true });
      await Promise.all(
        tracked.flatMap(({ context, page }, index) => [
          context.tracing.stop({ path: `${EVIDENCE}/${slug(name)}-${index}.zip` }),
          page.screenshot({ path: `${EVIDENCE}/${slug(name)}-${index}.png` }).catch(() => {}),
        ]),
      );
      throw error;
    } finally {
      await Promise.all(tracked.map(({ context }) => context.close()));
      await browser.close();
    }
  });
}

// Polls until the element's attribute has the value, within the suite's timeout. The page
// re-renders after a form action, so the element may be replaced while this waits.
export async function waitForAttribute(locator: Locator, name: string, value: string) {
  const deadline = Date.now() + TIMEOUT;
  let actual: string | null = null;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      actual = await locator.getAttribute(name, { timeout: Math.max(1, deadline - Date.now()) });
      failure = undefined;
    } catch (error) {
      failure = error;
    }
    if (!failure && actual === value) return;
    await sleep(100);
  }
  throw new Error(`${name} is ${JSON.stringify(actual)}, not ${JSON.stringify(value)}`, {
    cause: failure,
  });
}

// Signs the page in with the emailed magic link and waits for the page it lands on.
export async function signIn(page: Page, email: string, next = "/play") {
  await page.goto(`/signin?next=${encodeURIComponent(next)}`);
  await page.getByTestId("signin-email").fill(email);
  await page.getByTestId("signin-submit").click();
  await page.getByTestId("signin-sent").waitFor();
  await page.goto(await signInLink(email));
  await page.waitForURL((url) => url.pathname === next);
}
