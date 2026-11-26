import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountPanel } from "../app/account/account-panel";
import { SignInPanel } from "../app/sign-in-panel";
import * as UI from "../app/game-ui";
import { DEFAULT_LIMITS, playerLimits } from "../lib/limits";

const rules = { monitorIsolation: false, bugFixRequired: true, jailbreakCatch: false };
const pages: Record<string, string> = {
  "How to play": renderToStaticMarkup(
    createElement(UI.RulesPanel, {
      submissionUrl: null,
      rules,
      limits: playerLimits(DEFAULT_LIMITS),
    }),
  ),
  Leaderboard: renderToStaticMarkup(
    createElement(UI.LeaderboardPanel, {
      scores: [],
      models: [],
      boardAgent: "",
      onAgentChange: () => {},
    }),
  ),
  "Sign in": renderToStaticMarkup(
    createElement(SignInPanel, {
      email: "",
      sent: false,
      busy: false,
      error: "",
      onEmailChange: () => {},
      onSubmit: () => {},
    }),
  ),
  Account: renderToStaticMarkup(
    createElement(AccountPanel, {
      email: "me@example.com",
      displayName: "Night_Owl-7",
      next: null,
      notice: null,
    }),
  ),
};

test("every app page opens with its title and a subtitle directly under it", () => {
  for (const [title, html] of Object.entries(pages))
    assert.match(html, new RegExp(`<h2>${title}</h2><p class="lede">[^<]+`), title);
  // My runs renders its title in GameUI and the subtitle through this component.
  assert.match(
    renderToStaticMarkup(createElement(UI.RunHistoryIntro, { signedIn: true })),
    /^<p class="lede">/,
  );
});
