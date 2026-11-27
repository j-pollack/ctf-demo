# Release gate, part 2, stage 2c-1: run stories that need no worker

Worktree: `/Users/jonathan/Code/ctf/.worktrees/e2e-gate`
Branch: `feature/e2e-gate`, reset to `main` at `5d7c652` after pull request 50 merged. Clean tree.
Request: on 2026-11-26 the user said these must be tested in the browser: a run with several sessions, stopping a response, auto-continue, budget and quota refusals such as a fourth run in a day, and the admin game-rule toggles changing how a run plays. The status plan also lists starting a run, streamed output, a reload, capture and a catch.

Roles: lead Claude Fable 5.2. Plan verifier and code reviewer Claude Opus, high effort, read-only. Developer Claude Sonnet, medium effort. The user allowed commits, pushes and pull requests. A merge needs the user's yes.

## Problem

The browser suite on `main` has thirteen stories and none starts a run. The run path is the product: a member starts a run, instructs an agent, and the run ends as captured, caught or exhausted. It reaches three external services the suite does not fake yet: Sprites, OpenRouter's catalogue and chat completions, and the text screens on OpenRouter's `systemone` endpoint.

## Split of stage 2c

A read-only survey on 2026-11-26 traced the run path and sorted the stories by what they need. The user then decided two open points the same day.

- **Stage 2c-1, this contract.** Stories the app process can play alone: start and stream, reload, several sessions, a catch by flag output, the quota and budget refusals, the jailbreak rule, and stopping a response.
- **Stage 2c-2, a later contract.** Stories that need the monitor worker as a second process: capture and the leaderboard, a catch of a disguised read by the investigator, the bug-fix rule and the isolation rule. Auto-continue goes there too. The user chose to make the response time limit an admin setting, on branch `feature/response-time-limit`, and the story sets it low.

The user confirmed that both catches are tested: a printed flag here, a disguised read in stage 2c-2.

## Proven by a spike on 2026-11-26

A throwaway run of the suite with a scratch preload and one scratch story, all removed afterwards:

- A preload that patches `SpritesClient.prototype` and `Sprite.prototype` reaches the built app. `POST /api/games` returned 200 and the patched `createSprite`, `updateNetworkPolicy` and `execFileHTTP` were called, the last with the seed archive and the flag write.
- With `VERCEL_URL` set to a test host and `SITE_URL` empty, the run got `https://<host>/v1/end` as its submission URL, and all thirteen existing stories still passed, sign-in included.
- `POST /v1/end/<token>` on loopback answered 400 with no extra headers and 401 with `Host: <host>` and `x-forwarded-proto: https`, so a fake can deliver an upload to the real route. Uploads are stage 2c-2.
- Starting a run calls `cleanup()`, which deleted the Sprite of the ended run that the report story inserts.

## Scope

1. **Sprite fake**, `tests/e2e/sprite-fake.ts`, installed by the preload when `E2E_SPRITE_DIR` is set. It replaces `createSprite`, `deleteSprite`, `updateNetworkPolicy`, `getNetworkPolicy`, `execFileHTTP`, `execFile` and `listSessions` on the two prototypes. The plan verifier confirmed these are every Sprite call `lib/` makes.
   - State lives in `E2E_SPRITE_DIR`, one directory per Sprite name, holding the flag and the policy. A second process can read it in stage 2c-2. `createSprite` fails when the directory exists and returns a `Sprite`, because the app calls `execFileHTTP` on the result. `deleteSprite` removes the directory and throws a "404 not found" error when it is absent, which `destroyEnvironment` tolerates.
   - It validates what the app sends: the create options, the two policy rules with the endpoint host first, the `bash -c` seed command with an archive on stdin, and for `execFile` the `timeout -k 2 15 bash -lc <command>` form, the working directory, `maxRunAfterDisconnect: "1s"` and an `env.TARGET` that starts with the submission URL.
   - `execFile` answers from a fixed command table. The table holds the commands the scripted agent issues and nothing else. `cat /tmp/flag.txt` returns the Sprite's flag.
   - A call it does not expect throws. A patched method runs outside the fetch guard, so the Sprite fake writes its own line to the violations file.
2. **OpenRouter fake**, `tests/e2e/openrouter-fake.ts`, registered in the preload.
   - `GET /api/v1/models` returns a catalogue with every model in `MODELS`. Each entry has what `getModel` requires: `context_length`, `pricing.request` of "0", `prompt` and `completion` prices above zero and small enough that the output-token reservation fits the run budget, and `supported_parameters` with `reasoning` and `tools`. The handler also awaits the lazy imports the other handlers need, so the first screen request does not pay for them inside its 2 second deadline. The prompt route always reads the catalogue first.
   - `POST /api/v1/chat/completions` is a scripted agent. When the last message has role `tool`, it replies with text only. Otherwise it reads a keyword from the last user message and replies with a stream built by `tests/integration/completion-stream.ts`: text, or a `sprite_exec` tool call. The keywords and their commands are one table shared with the Sprite fake. It validates the bearer key, `stream: true`, a model from the catalogue and a `session_id` in the app's form. A request with no keyword is rejected. Every story's instruction carries a keyword.
   - The jailbreak keyword is in the table with a text reply, for the run that plays with the rule off. Three keywords change the reply beyond the command: one prints the flag, one reports a cost of $0.60 on a completion that also issues a tool call, and one holds the stream open before its first chunk until the request is aborted.
   - `POST /api/v1/systemone` is dispatched by question set. Text screens go to `tests/integration/screen-fake.ts` with one scoring rule fixed at install: 0.95 on a question that counts as a lose signal for text holding the jailbreak keyword, the fake's default otherwise. The display-name set keeps going to the existing fake. Any other set is rejected.
   - It does not answer the generation endpoint. No story here leaves a hold with a generation id, so a reconcile request would be a defect and is refused as a violation.
3. **Runner and environment.**
   - Server: `VERCEL_URL` set to a test host, and `E2E_SPRITE_DIR`, a directory under `.artifacts/e2e/` that the runner empties at the start.
   - Tests: `E2E_SPRITE_DIR` and the synthetic cron secret.
   - `text_screen.request_timed_out` joins the server log events that fail a story. A screen that times out lets an instruction through unscreened, and no story should pass that way.
   - After the stories, before the database is removed, the runner checks criterion C6.
4. **Test ids** on the run UI under `app/`, by the rules of `docs/plans/e2e-gate-testids.md`: the start button, the dialog's confirm button and its notes with a `data-state`, the refusal alerts, the instruction field, send, stop, the transcript and its entries with their kind in `data-state`, tool call and output, session chips and the add-session control, whether a session is busy or idle in a `data-state`, the run status with the status in `data-state`, and the caught cause.
5. **Teardown.** No route lets a member end an active run. A story that leaves a run active ends it in a `finally`: it sets that one run to `ended` with SQL scoped to the run's id, then calls the cleanup route with the cron secret so the app deletes the Sprite. This is the test's own teardown and not behaviour under test.
6. **Stories.**

   | Id  | Story                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
   | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | R1  | A member starts a run from `/play`, sends an instruction and sees the agent's text, a tool call and its output arrive. The stored session holds the same messages.                                                                                                                                                                                                                                                                                                            |
   | R2  | After a reload the transcript shows the same entries in the same order.                                                                                                                                                                                                                                                                                                                                                                                                       |
   | R3  | A member adds a second session and instructs it. Each session shows only its own entries. With the limit at two sessions the add control is unavailable.                                                                                                                                                                                                                                                                                                                      |
   | R4  | The agent prints the flag with `cat /tmp/flag.txt`. The run ends as caught, the page shows the caught state and the cause, the stored run is `caught` with cause `flag_output`, and its Sprite directory is gone. The story declares no server failure.                                                                                                                                                                                                                       |
   | R5  | The fourth run in a day. With the default limit of three, a member starts three runs, sending one instruction in each and waiting for the session to be idle before the next start. The start dialog then shows its no-runs-left state without the unused-run note, and the confirm button is disabled. A direct `POST /api/games` with an `Origin` header answers 429 and stores no fourth run.                                                                              |
   | R6  | With the daily budget cap at zero, starting a run is refused: the alert shows, the request answers 429 and no run is stored.                                                                                                                                                                                                                                                                                                                                                  |
   | R7  | The overspend keyword makes one completion report $0.60 against the $0.50 run budget and issue a tool call. The follow-up completion in the same response is refused, the run ends as `exhausted`, the page shows that state, the composer is gone, and a direct `POST` to the prompt route answers 409. The story declares `game.response.failed`.                                                                                                                           |
   | R8  | An admin turns the jailbreak rule on at `/admin`. A member's new run gets an instruction holding the jailbreak keyword: the run ends as caught and no row with role `agent` exists in `ctf.inference` for that run. The admin turns the rule off, and, once the first is idle, a second new run with the same instruction gets an agent reply and stays active.                                                                                                               |
   | R9  | The report story starts its run through the app, adds a second session and files the report from it, replacing the inserted rows.                                                                                                                                                                                                                                                                                                                                             |
   | R10 | The fail-closed story gets a new trigger, because the catalogue is now faked: it registers a worker wake address on an unfaked `https` test host, calls the cleanup route with the cron secret, takes the one recorded violation and declares `worker.wake.failed`. It removes the registration afterwards. The model-change check that used to trigger the refusal becomes a success case: the admin changes the model, the stored value changes, and the story restores it. |
   | R11 | A member sends the hold keyword. Once `ctf.inference` holds an unsettled row with role `agent` for the run, the member presses Stop. The transcript shows the stopped entry in its resumable state, the run stays active, and a further instruction gets a reply. The story declares `inference.failed` and `game.response.failed`.                                                                                                                                           |

## Non-goals

- The monitor worker, capture, the leaderboard, a catch by the investigator, the bug-fix and isolation rules, uploads, stopping a running command and auto-continue. Stage 2c-2.
- Any change under `lib/`, `db/` or to app behaviour. Edits under `app/` add `data-testid` and `data-state` only.
- A Sprite shell emulator. The command table is fixed.
- The real mode on staging. Part 3.

## Design constraints

- **Lazy imports.** The preload imports nothing from `lib/` at load time. `lib/db` would create a pool on `globalThis` that the built app then adopts. The existing fakes import lazily, and the new ones do the same.
- **Fakes fail closed.** A request or command a fake does not expect throws and leaves a violation, which fails the story.
- **Open environments.** The app admits at most ten active runs across all members. Every story that leaves a run active uses the teardown in scope item 5. No story raises the limit.
- **Settings.** A story that changes a limit or a rule restores it in a `finally`, as the existing admin and game-rule stories do. A run copies its rules when it starts, so a rule is set before the run that should play under it.
- **Declared failures.** The table of stories names each server failure event a story declares. R5 and R6 also declare the 429 the browser's own request receives. If a story logs an event the table does not name, the developer stops and reports it.
- **Timing.** Stories wait on test ids and `data-state` with the suite's timeout and use no fixed sleep. The live transcript arrives by server-sent events, not by the 3 second poll.
- **Selection.** `getByTestId` with literals only. Both guards on `main` must pass, including the rule that no literal id is matched by a template.

## Acceptance criteria

| Id  | Given, when, then                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Given the suite, when `npm run test:e2e` runs three times in a row, then every story passes each time, the eleven above and the eleven untouched ones, twenty-two in all, with no violation and no undeclared server failure.                                                                                                                                                         |
| C2  | Given a command outside the Sprite fake's table, an `execFile` without the expected form, or a completion request with no keyword, a wrong key or a model outside the catalogue, when the fake receives it, then it throws and a violation is recorded. Given a last message with role `tool`, then the agent fake replies with text and no tool call. Offline tests cover each case. |
| C3  | Given each story R1 to R8 and R11, when its key assertion is mutated, then that story fails. The developer mutates one assertion per story and records the failure.                                                                                                                                                                                                                   |
| C4  | Given the edits under `app/`, then the word diff used in the test id contract shows no removed token and only `data-testid` and `data-state` additions, plus any `TEST_IDS` constant.                                                                                                                                                                                                 |
| C5  | Given R8 with the rule on, then `ctf.inference` holds no row with role `agent` for that run.                                                                                                                                                                                                                                                                                          |
| C6  | Given the end of a full run of the suite, then no run is `active` or `creating`, and the directories in `E2E_SPRITE_DIR` are exactly the Sprite names of runs whose Sprite is not marked deleted.                                                                                                                                                                                     |
| C7  | Given the whole change, when `npm run check` and `npm run test:integration` run, then both pass. The lead's failure-path script still passes: a failing story, a bound port and an interrupt each exit non-zero and leave no container, server or browser.                                                                                                                            |
| C8  | Given `ci` on GitHub, then the `e2e` job passes and stays under three minutes. The developer measures the suite locally before and after and reports both times.                                                                                                                                                                                                                      |

## Criterion, check and evidence

| Id  | Check                                                                                                               | Evidence                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Three runs by the developer and three by the lead.                                                                  | Developer: 3 runs before and 3 after the review round, 22 of 22. Lead on 2026-11-26: 3 runs before and 3 after, 22 of 22, about 39 seconds wall each.                                                                                                                                                                              |
| C2  | Offline tests of the two fakes, written first and seen failing.                                                     | `tests/e2e-sprite-fake.test.ts` and `tests/e2e-openrouter-fake.test.ts`, 14 tests. Both files first failed for want of their module.                                                                                                                                                                                               |
| C3  | The developer's mutation record. The lead repeats two of them.                                                      | The developer mutated one assertion in each of R1, R3 to R8 and R11, and each failed that story. The lead ran R4 with no flag printed and R8 with the rule left off: each failed on `data-state is "active", not "caught"` and the other twenty passed. After review, R1 with the prompt request held failed on its response wait. |
| C4  | The word diff against `5d7c652`. The reviewer reads it.                                                             | Lead ran the word diff after the review round: no removed token. Added tokens are the attributes and two pairs of parentheses the formatter put around JSX in `app/run-dialog.tsx`.                                                                                                                                                |
| C5  | An assertion in R8 on `ctf.inference`.                                                                              | `tests/e2e/run-rules.test.ts` reads `ctf.inference` for the caught run and expects no agent row.                                                                                                                                                                                                                                   |
| C6  | A check in the runner after the stories and before the database is removed, with an offline test of its comparison. | `runProblems` in `scripts/test-e2e.ts`, with offline cases in `tests/e2e-runner.test.ts`. It also fails a full run in which no story started a run.                                                                                                                                                                                |
| C7  | The three commands.                                                                                                 | Lead: `npm run check` 672 of 672, `npm run test:integration` 648 of 648, and the failure-path script: a failing story exits 1 with a trace and a screenshot, a bound port exits 1, an interrupt during the tests or the build exits 130, each with no container, server or browser left.                                           |
| C8  | The run on the pull request.                                                                                        | Pending the pull request.                                                                                                                                                                                                                                                                                                          |

## Steps

1. Offline tests for the Sprite fake and the agent fake. Verify: they fail for want of the modules.
2. The two fakes, the preload registration and the runner's two variables. Verify: C2, and the twelve existing stories other than the fail-closed one still pass. That story loses its trigger here and is rewritten in step 5.
3. Test ids for the start flow and the transcript, then R1 and R2. Verify: both pass.
4. R3, R4, R5 to R8, then R11, each with its ids. Verify: each passes alone and with the suite.
5. R9 and R10. Verify: the report and fail-closed stories pass with the catalogue faked.
6. Mutations for C3, the end-of-run check for C6, `docs/verification.md`. Verify: C1, C7.

## Ownership

Owned: `tests/e2e/`, new offline tests under `tests/` for the two fakes, `scripts/test-e2e.ts`, `tests/e2e-runner.test.ts` and `tests/e2e-preload.test.ts` for the runner and preload changes, attribute-only edits under `app/`, other existing offline tests under `tests/` only where an added attribute changes what they match, `docs/verification.md`, this plan.

Not owned: `lib/`, `db/`, `tests/integration/`, the workflows, `package.json`.

A test in the commit hook's environment must not run `git`. If one has to, it deletes every `GIT_` variable first.

## Risks and open questions

- **A start during a live response.** The start control enables as soon as the instruction is stored, which can be before the response ends. A start then stops the old response and logs a failure the story did not declare. Stories wait for the idle state first.
- **The 230 second response deadline and the 45 second stream idle bound** cannot be shortened by configuration on `main`. No story in this stage waits for either. R11 ends its held response with Stop.
- **Suite time.** Eleven more stories may add 30 to 60 seconds. C8 bounds it.
- **Coverage that moves.** With the catalogue faked, the refusal of an unfaked model-list request is no longer exercised. R10's wake request takes its place as the proof that the guard is on in the real server.
- **A defect seen during the survey, outside this contract.** In `lib/runner-async.ts` a 504 with an unfired deadline signal is not marked resumable or auto-continue. The user approved a fix on branch `fix/auto-continue-stall`. No story here depends on it.

## Plan verification

An independent read-only check on 2026-11-26 approved with changes: three high findings, five medium and nine low. All are folded in.

- No route ends an active run, so teardown is the test's own SQL and the cleanup route.
- A run is exhausted by the next reservation and not by the completion that overspends, so R7's overspend reply carries a tool call.
- A keyword in the last user message would be matched again on the turn after a tool result, so the agent fake answers a tool result with text.
- The fake's request log is not readable from a test, so C5 reads `ctf.inference`.
- A cold import could push the first screen past its 2 second deadline and let R8's instruction through unscreened, so the catalogue handler warms the imports and a screen timeout fails a story.
- R5's disabled button had two causes, so the story sends an instruction first and asserts the note that distinguishes them. It uses the default limit, which is the fourth run the user named.
- Stopping a held completion needs no worker, so it is R11 here.
- The environment per stage, the ownership of the two offline suite tests, the catalogue entry shape, the Sprite fake's extra validation and its own violation line, the declared failures per story, R8's two runs and its admin toggle, the dropped generation fake, a C6 that cannot pass vacuously, and the model-change success case are all stated.

A second pass the same day confirmed all seventeen closed and added six wording changes, also folded in: a story waits for the session to be idle before a new start, R11 presses Stop only once the completion is reserved, the fail-closed story is excepted from step 2's check, the story count is twenty-two, R11 is in the steps, and the jailbreak keyword has a reply in the agent's table. The verifier confirmed the teardown deletes the Sprite at once, that three starts with the default limit replace cleanly, and that a session accepts an instruction after a stop.

## Changes from the design, and the review

- **Existing component tests.** Seven offline tests matched exact markup, and eighteen of their assertions broke on the new attributes. They now render through `tests/markup.ts`, which strips `data-testid` and `data-state`, so no assertion was edited and none can be satisfied by an attribute's value. The contract had allowed only per-regex edits. The reviewer judged the wrapper sound. No offline test pins the new `data-state` values: the browser stories do.
- **The agent fake reads the last message that is not a system message**, because the app's request ends with system messages.
- **A paused transcript entry** carries `data-state="resumable"` and not its kind, which is how R11 reads it.
- **One id beyond the list**, `run-new` on the New run button, which R5, R8 and R9 need to start from a run page.
- **The preload refuses to load** when the Sprite directory is set without the test host.
- **`listSessions`** is patched and returns an empty list for a known Sprite. No story in this stage calls it.

An independent read-only review on 2026-11-26 found no P0 or P1 and three P2, fixed in the one corrective round and confirmed closed with nothing new at P0 to P2.

- R1 did not prove streaming, because the page also re-reads the run when a response ends and on a 3 second poll. R1 now holds every browser read of the run while the instruction is in flight and asserts that the prompt response is an event stream, so the entries it waits for can only arrive from the stream.
- R8's check that the second run stays active resolved at once. It now waits for the session to be idle and reads the stored status.
- R8 ended only its second run. It ends both.

Notes left as they are: R1's hold does not cover the list read `GET /api/games`, which the page does not make while a response runs. R6 does not pin which of three possible 429 causes it received. `getNetworkPolicy` returns what was stored, so the app's own policy check cannot fail against the fake, and the real Sprite smoke test owns that contract.
