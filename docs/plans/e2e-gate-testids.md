# Release gate, part 2: select by test id in the browser suite

Worktree: `/Users/jonathan/Code/ctf/.worktrees/e2e-gate`
Branch: `feature/e2e-gate`, pull request 50
Baseline: `0528173`, the merge of `main` at `953c9ad` into the branch. Clean tree.
Request: on 2026-11-26 the user asked whether the suite selects elements by `data-testid`. It did not. The same hour, a copy change on `main` broke four of the thirteen stories. The user wants `data-testid` used for element selection, and told the lead to merge pull request 50 once this is pushed and CI is green.

Roles: lead Claude Fable 5.2. Plan verifier and code reviewer Claude Opus, high effort, read-only. Developer Claude Sonnet, medium effort. The user allowed commits, pushes and pull requests, and this one merge.

## Problem

The stories in `tests/e2e/` find elements by role, label and visible text. Stages 2a and 2b were written that way on the lead's instruction, and their contracts ruled out edits under `app/`. After `main` gained new copy in `953c9ad`, the merge was clean and the offline checks passed 645 of 645, but four stories failed: both page-load stories and both game-rule stories. Each waited for a heading or a sentence whose words had changed. A copy edit should not fail a story about behaviour.

## Scope

Every element a story touches gets a `data-testid` in the app, and the stories select by it. Two offline tests keep the rule.

## Non-goals

- Changing behaviour, copy, styles or accessibility attributes in the app.
- Removing the offline component tests that assert labels and copy. They stay the place where wording and accessible names are checked.
- The release checks of part 4. They switch their page markers to these test ids after this change is on `main`.
- New stories.
- A custom not-found page. Next renders its own, which cannot carry a test id.
- Test ids on components the app does not own, such as the dialog from `@ui-sdk`.

## What changed on `main` that the stories must follow

The plan verifier read the merged code on 2026-11-26.

- The heading on `/play` that the bug-fix story waited for is gone, and nothing on `/play` reads the current rules.
- On `/`, the short form of "How to win" no longer shows the isolation or the jailbreak sentence. It still lists the bug-fix condition as its own item.
- On `/rules`, the isolation wording is one of two texts chosen by the rule, and the jailbreak sentence is a text fragment with no element of its own.

## Design

1. **Selection rule.** A story finds elements with `getByTestId` only, alone or chained, and always with a literal string. These are not used in `tests/e2e/`: `getByRole`, `getByLabel`, `getByText`, `getByPlaceholder`, `getByTitle`, `getByAltText`, `locator(` with a selector string, `frameLocator`, `waitForSelector`, `$`, `$$`, `$eval`, and the page-level `click`, `hover`, `check`, `dblclick`, `textContent`, `innerText`, `inputValue` and `isVisible` that take a selector string.
2. **What a story may still pass or assert as text.** Data the story supplied or the database holds: an email address, a display name, a message body, an id, a number, a form value and a select option's value. Where the app renders its own words around such data, the story matches the data as a substring of the element's text. A story does not assert the app's own wording.
3. **State without wording.** Where a story needs a state that the page shows in words, the element carries it in a `data-state` attribute and the story asserts the attribute. This covers:
   - the feedback thread's state, each thread entry's side, and the state on each row of the admin feedback list;
   - the email-change notices;
   - the four status lines that always render and fill in when something happens: the display-name status and the email status on the account page, the contact form's status and the report form's status;
   - on `/rules`, the element that describes transcript isolation and the element that describes the jailbreak catch, each with the rule's value.

   A switch keeps its `aria-checked`, which the story reads from the element found by test id.

4. **Presence.** Where an element exists only in one state, the story asserts that it is present or absent. The bug-fix condition in "How to win" on `/` is the one case.
5. **Two fragments with no element.** In `HowToWin` in `app/flag-instructions.tsx`, the isolation text and the jailbreak sentence are bare text. Each may be wrapped in a plain `<span>` carrying only `data-testid` and `data-state`. The jailbreak span always renders and holds its sentence only when the rule is on, so its state can be read in both positions. These two spans are the only new elements. The same wording also appears in `app/game-ui.tsx`, and those copies get no id.
6. **Rows in a list.** Repeated elements share one test id. A story narrows them with `filter({ hasText })` on data it supplied, or with a second test id inside the row. Rows built in a loop over keys take the key in their id through a template, such as `admin-limit-${key}`.
7. **Page roots.** The game layout puts one id on its outer element, taken from a constant named `PAGE_TEST_IDS` that maps each panel it can show to a literal id, so `/rules`, `/rank`, `/signin`, `/play`, `/runs` and a run page each have their own. The id follows the panel's name in the code, so the history panel is `page-history`. The pages outside that layout carry their own roots: `page-home`, `page-contact`, `page-account`, `page-admin` and `page-admin-feedback`. Every root is in the server HTML. The member story for `/play` also waits for `play-no-run`, the block that renders only once the member's session and run state have loaded.
8. **Names.** Lower case with hyphens, `<area>-<thing>`, named for what the element is and not for its wording. A part that comes from a key keeps the key's own spelling. Unique within a page except for list rows. A new attribute goes last on its element.
9. **Waiting for an attribute.** `tests/e2e/browser.ts` gains one helper that polls a locator until an attribute has a value, with the suite's timeout. Stories use it for `data-state` and `aria-checked`.
10. **The guards.** Two offline tests.
    - The first reads every file under `tests/e2e/`, strips comments, and fails on any call named in item 1, with the file and line. It does not flag `fill`, `selectOption`, `getAttribute`, `filter` or calls on `page.request`.
    - The second collects the literal ids the stories pass to `getByTestId` and the `data-testid` expressions under `app/`. A string literal must match exactly. A template matches as a pattern in which each interpolation stands for one or more characters, so a templated id is checked by its fixed parts only. The string values of a constant whose name ends in `TEST_IDS` count as literals. It fails on a story id that nothing under `app/` matches, naming the id.
11. **Fixtures.** The report story's inserted run gets a session id different from the run id, and the story asserts that both ids appear in the admin row. The model-change story takes the second model from `MODELS`, as the report story does.
12. **The not-found story.** It asserts the 404 status and that `page-admin` is absent.
13. **Documentation.** `docs/verification.md` states the rule in two sentences under "Writing tests".

## Acceptance criteria

| Id  | Given, when, then                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Given the files under `tests/e2e/`, when the first guard runs, then it finds none of the calls in design item 1. Given a file that uses one, then it fails and names the file and line. Given `fill`, `selectOption`, `getAttribute`, `filter({ hasText })`, a `page.request` call or a banned name inside a comment, then it does not fail. |
| T2  | Given the branch with `main` merged in, when `npm run test:e2e` runs, then all thirteen stories pass, three times in a row. The four stories that the copy change broke pass without any wording from the app in them.                                                                                                                       |
| T3  | Given a story id that nothing under `app/` matches, when the second guard runs, then it fails and names the id. Given `page-run` used by a story while only `page-runs` exists, then it fails. Given an id that a template under `app/` produces, then it passes.                                                                            |
| T4  | Given the edits under `app/`, then every added token belongs to a `data-testid` or `data-state` attribute, to one of the two spans in design item 5, or to the `PAGE_TEST_IDS` constant, and no token is removed.                                                                                                                            |
| T5  | Given the game-rule stories, then the bug-fix story asserts the condition's presence, absence and presence again on `/`, and the other story asserts each rule's `data-state` on `/rules` going from off to on. Each also asserts the switch, the admin's address as a substring of the changed-by line, and the stored value.               |
| T6  | Given the whole change, when `npm run check` and `npm run test:integration` run, then both pass.                                                                                                                                                                                                                                             |

## Criterion, check and evidence

| Id  | Check                                                                                                                                                                                     | Evidence                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | The guard test, seen failing on the untouched stories first, then passing, with cases for each allowed and banned form.                                                                   | `tests/e2e-selectors.test.ts`. The developer saw it fail on the untouched stories with 162 hits in 10 files, then pass. The reviewer ran it on the stories at `0528173` and it failed. It passes in `npm run check`.                                         |
| T2  | Three runs by the developer and three by the lead.                                                                                                                                        | Developer: 3 runs, 13 of 13. Lead on 2026-11-26: 3 runs before review and 3 after the fixes, 13 of 13 each, about 18 s of tests per run.                                                                                                                     |
| T3  | The second guard's own tests, written first.                                                                                                                                              | `tests/e2e-test-ids.test.ts`, six tests. The reviewer removed `admin-rule-switch`, `admin-rule-changed` and `admin-limit-field` from the app sources in memory, and the guard named each.                                                                    |
| T4  | `git diff --word-diff=porcelain --word-diff-regex='[^[:space:]<>{}="]+\|[<>{}="]' 0528173 -- app/` shows no removed token and only the allowed added tokens. The reviewer reads the diff. | Lead ran the command after the fixes: no removed token. Added tokens are the attributes, the two spans and the constant with its one comment line. The reviewer read the diff and rendered `HowToWin` in both rule positions: the visible text is unchanged. |
| T5  | The two stories, each seen failing when its assertion is mutated.                                                                                                                         | Lead mutated both assertions in one run: A2 failed with `actual: 0, expected: 1`, A3 failed with `data-state is "on", not "off"`, the other eleven passed. File restored and compared.                                                                       |
| T6  | Both commands.                                                                                                                                                                            | `npm run check`: 654 of 654 after the fixes. `npm run test:integration`: 648 of 648, run before the review fixes, which changed two test id values under `app/admin/` and test files only.                                                                   |

## Steps

1. The first guard test. Verify: it fails and lists the current locator calls.
2. Page roots, the attribute helper and the page-load stories. Verify: the two page stories pass on the merged copy.
3. One story file at a time: add the ids it needs under `app/`, switch its locators, run it. Order: sign-in and the `signIn` helper, display name, admin, contact, report, email change, game rules, feedback reply. After each, run the offline tests for the components touched.
4. The second guard test. Verify: T3.
5. `docs/verification.md`. Verify: `npm run check`.

## Ownership

Owned paths: files under `app/` for the edits design items 3 to 8 allow, `tests/e2e/`, the new offline guard tests under `tests/`, `docs/verification.md`, this plan.

An existing offline test under `tests/` may change only where an added attribute changes what it matches. The plan verifier named these: `sign-in-panel.test.ts`, `account-panel.test.ts`, `contact-form.test.ts`, `report-problem.test.ts`, `feedback-card.test.ts`, `game-rules-copy.test.ts`, `run-dialog.test.ts` and `feedback-thread.test.ts`. Each such edit keeps the test's meaning. Where a `data-state` would let an assertion on a state word pass however the text renders, the assertion is tightened so it still checks the text.

Not owned: `lib/`, `db/`, `tests/integration/`, `scripts/`, the workflows.

## Risks and open questions

- **Offline tests that match markup.** The list above is the verifier's reading. The developer reports any other test that an attribute breaks before editing it.
- **The `/play` wait.** A page root resolves before the session loads. Design item 7 adds a second wait for that page.
- **Accessible names are no longer exercised by the browser suite.** The offline component tests assert them, and they are unchanged in meaning.
- **Test ids ship to production.** They add a few hundred bytes of inert attributes. The ids built from keys are on admin pages only, and each `data-state` repeats what the page already shows.

## Plan verification

An independent read-only check on 2026-11-26 blocked the first draft on three gaps and listed eight more findings. A second pass approved with three more, also folded in: the word diff uses a token pattern that survives an attribute placed before `>`, the span is limited to two named fragments and always renders, and page ids are literals in a constant the guard can read. All of the first pass are folded in: the rule stories follow the pages as they are after the copy change, an attribute wait is named, the status lines that always render carry a state, ids built from keys and the second guard's matching are defined, the game layout carries one root built from its panel, the not-found story asserts the status and an absent root, text around data is matched as a substring, the first guard's banned and allowed calls are listed, the offline tests that will change are named, and the hand-reworded proof is dropped in favour of the merged copy itself.

## Changes from the design, and the review

- **Row ids.** Rows built over keys are `admin-rule-row-${key}` and `admin-limit-row-${key}`, not the `admin-limit-${key}` form in design item 6. With the shorter prefix the template also matched the ids of the elements inside the row, so the second guard could not see one of them go missing. A third guard test now fails when a literal id under `app/` is also matched by a template.
- **Report fixture.** Design item 11 asked for one session with an id different from the run id. The app creates a run's first session with the run's own id and returns 404 for a run that has no such session, so the fixture inserts two sessions and the story reports the second. The stored `session_id` is asserted to be the second session's.
- **Shared source helper.** `tests/e2e/source.ts` blanks comments and string contents for both guards.

An independent read-only review on 2026-11-26 found no P0 or P1 and two P2: the template collision above, and two assertions in `tests/feedback-thread.test.ts` that the new `data-state` attribute could satisfy. Both were fixed in the one corrective cycle, and the same reviewer confirmed them closed with nothing new at P0 to P2.

Known limits, left as they are:

- The first guard reads syntax. It does not catch bracket access, a destructured locator method, `page.evaluate` with a selector, or `filter({ hasText })` given the app's wording. It would flag `page.mouse.click(x, y)`, which no story uses.
- The second guard does not compare one template with another.
- `rules-isolation` and `rules-jailbreak` appear once per session pane on a run page. No story selects them there.
- Mail subjects in the stories are still the app's wording. They are not element selection.
