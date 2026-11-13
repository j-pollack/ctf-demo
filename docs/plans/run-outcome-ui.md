# Run outcome UI fixes

Worktree: `/Users/jonathan/Code/ctf/.worktrees/run-outcome-ui`
Branch: `feature/run-outcome-ui`
Baseline: `a9ee8aaa4e2b436d088d11158c954141e1d88a82` from the checkout serving the screenshot. Primary and existing feature worktrees are unchanged. No pre-existing changes in this feature checkout; local dependency symlink is temporary and untracked.

User scope: hide Fork; correct the overlapping run-details panel; show the definitive caught outcome rather than 90% advisory risk. The follow-up difficulty question is explanation-only; difficulty behavior stays unchanged.

## Acceptance

- U1: Fork actions are hidden even when the API marks a run forkable. Visible notice/rules/detail copy no longer advertises the unavailable action. Preserve backend behavior and stored fork history.
- U2: Run details stays in normal document flow when opened, remains keyboard-operable, and pushes the transcript/results below it at desktop and mobile widths. No floating overlap, nested panel scrollbar or horizontal overflow.
  While details is open, the console becomes the single scroll container and the transcript/thread grow in normal flow. Closing restores the existing transcript scroller. Browser fixtures include the real `.app → .workspace → .console → monitor/transcript/thread` ancestry, long receipts and a short mobile viewport; the terminal result must remain scroll-accessible.
- U3: A caught run's headline says **Caught**, blocked says **Blocked**, captured says **Captured**, finalizing says **Finalizing**. Other ended runs show their outcome. Active runs retain advisory risk and missing-risk behavior. Historical scores/chart remain accurate and explicitly labeled as history rather than a final result.
- U4: Add focused render regressions; verify actual UI components and global CSS in a browser fixture at desktop/mobile, including opening/closing details and visible outcome. Run `npm run check` and `npm run test:coverage`. Independent review approves.

## Approach

Small changes to `app/game-ui.tsx` and `app/globals.css`, targeted existing tests plus a small outcome render test. Use an explicit disabled Fork UI switch so handlers/API need not be rewritten. A small risk summary component and native run-details wrapper allow real rendered-component verification without DB/auth/service fakes. Browser fixture is presentation-only, not live auth or full-route E2E proof. Coldtea browser tools are unavailable; use installed agent-browser.

Lead implements directly with independent available-agent plan/code review under the user-approved workflow fallback. Source reasoning settings cannot be selected through the available delegation tool. No paid calls, database writes, merge, push or deploy.

## Verification evidence

- Independent plan review approved after specifying open-panel scrolling and the full browser fixture ancestry.
- Baseline `npm run check` passed. New outcome/Fork render regressions failed against the original behavior, then passed after the fix.
- Post-change `npm run check` passed on Node 24.16.0: lint, formatting, types and all 228 tests. `npm run test:coverage` passed all 228 tests; all-runtime-source coverage is 33.12% lines/statements, 85.44% branches and 53.37% functions. These figures are repository coverage, not full-route UI proof.
- Before-fix browser reproduction: absolutely positioned details extended to y=867 while the transcript began at y=236, overlapping the result.
- Production CSS and exported React components in the offline fixture pass at desktop 1720×1100 and mobile 390×600: details is static/in-flow, transcript begins below details, no horizontal overflow, no Fork button, headline Caught, and the terminal result is visible after scrolling to the bottom. Closing restores console overflow hidden and thread overflow auto. Screenshots visually inspected.
- Native keyboard disclosure verified through Chromium CDP key events: Enter opens, Space closes, focus stays on SUMMARY, and scrolling changes/restores correctly. The agent-browser `press` command did not reliably deliver these keys; direct CDP verified the browser behavior without changing application code.
- Local presentation evidence is in ignored `.artifacts/run-outcome-ui/` (fixture source, generated pages and before/desktop/mobile screenshots). This exercises presentation only, not live authentication, routes or services.
- Initial independent review found that live-output follow still targeted the thread while details moved scrolling to the console. Corrected with `app/run-scroll.ts`: both automatic and send-to-bottom scrolling use the active container; scroll tracking follows the same container; disclosure toggles reset following from the new viewport position. Added pure scroll-state regressions. The Chromium regression in `.artifacts/run-outcome-ui/check-scroll.mjs` executes the actual helper source against real fixture DOM/CSS at both viewport sizes: new output follows, scrolling up pauses follow and preserves reader position, and closing restores thread scrolling. Both full offline gates were rerun after this correction.
- Independent final code review approved the full delta after the scroll-follow correction; no remaining findings.
