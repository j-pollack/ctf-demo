# Route Jev classifier calls through OpenRouter

Worktree: `/Users/jonathan/Code/ctf/.worktrees/jev-openrouter`
Branch: `feat/jev-openrouter`
Baseline: `911043d41414b39ad4341ff5d9a1684f0a91267b`. Index and working tree were clean. `npm run check` passed at baseline with 386 tests. The primary checkout stays unchanged.

## Request

Move Jev calls from TypeSafe's API to the OpenRouter model `typesafe/jev-1.14`, so classifier spend appears on the OpenRouter account next to agent and investigator spend.

## Scope and decisions

Every Jev call in the repository goes through `evaluate()` in `lib/typesafe.ts`. Production, the eval scripts and the calibration script all call it. The change is in that function, plus the fakes, scripts and docs that name the old URL, key or model id.

- Endpoint: `POST https://openrouter.ai/api/v1/systemone`. It implements TypeSafe's request and response shapes, so the request body and the answer validator stay as they are. OpenRouter's other Jev endpoint, `POST /api/alpha/decisions`, is marked alpha and its shape may change.
- Credential: `OPENROUTER_API_KEY`. `TYPESAFE_API_KEY` is no longer read anywhere.
- Model: `TYPESAFE_MODEL = "typesafe/jev-1.14"`. OpenRouter reports the serving model as `typesafe/jev-1.14-20261014`.
- Context mode: OpenRouter runs a text request over about 32,000 bytes in TypeSafe's long-context mode. TypeSafe describes that mode as slower and less accurate. On 2026-11-18 the user chose to keep the 90 KB document budget and accept long-context mode for those calls. This replaces the 2026-11-12 choice of normal context for documents between 32 KB and 90 KB. `lib/monitor-document.ts` is functionally unchanged.
- Too-large handling: the existing mapping of a 400 response containing `max_tokens_exceeded` to `TypesafeDocumentTooLargeError` stays. `max_tokens_exceeded` is also one of OpenRouter's canonical error types. With a 262,144 token window and a 90 KB document cap the provider cannot reject our documents for length, so the shrink-and-retry path becomes a backstop.
- Accounting: classifier cost is still input tokens times `MONITOR_TOKEN_MICRODOLLARS`. The live check showed `usage.cost` equal to that product on every call. `ctf.inference` rows written by `chargeMonitor` keep the model label `typesafe`. Bounded reviews reserve through `reserveInference` with `TYPESAFE_MODEL` as the row label, so those rows change from `jev-1.14.0` to `typesafe/jev-1.14`. Amounts do not change.
- Run stamp: runs created after the deploy store `monitor_model = "typesafe/jev-1.14"`. Monitor version constants are not bumped.
- Calibration cache: `scripts/monitor-calibrate.ts` caches answers on disk keyed by state and questions. The key gains `TYPESAFE_MODEL`, so a recalibration does not reuse answers from the direct route.
- Identifier names such as `TypesafeQuestion`, the file name `lib/typesafe.ts` and the `Typesafe …` error messages are unchanged. Scripts match on those messages.

## Non-goals

- No change to questions, thresholds, weights, document budget or monitor version stamps.
- No billing from `usage.cost`, no stored generation id for classifier rows, no `session_id` on classifier calls.
- No edits to frozen eval schedules under `evals/flag-read/`. They record past runs and hash `lib/typesafe.ts` as it was.
- No edits to historical plans under `docs/plans/`.
- No deployment, secret changes, merge or push.

## Assumptions and risks

- OpenRouter's slug carries no patch number. If TypeSafe ships a patched 1.14 under the same slug, scores could shift without a code change. The response `model` field would show a new dated slug.
- `evaluate` discards the response `model` field, so nothing would report that drift.
- The admin monitor breakdown groups by `monitor_model`, so runs before and after the change appear as separate rows. The admin spend-by-model card gains a row for bounded classifier reservations under the new label.
- A run created before the deploy keeps the stamp `jev-1.14.0` while its later reviews go through OpenRouter. An analysis that compares routes must split by review time, not by the run stamp.
- Long-context latency was measured at 41 KB only. The document cap is 89,856 bytes and the classifier deadline is 15 seconds.
- `TYPESAFE_API_KEY` should stay in Fly and Vercel until the change is confirmed in production. Rollback images and preview workers built from older commits still read it.
- The classifier now shares OpenRouter's availability and credit balance with the agent and investigator.
- The share of production classifier calls over 32 KB is unmeasured. A read-only query against production was blocked by the permission classifier.

## Live contract evidence

Run on 2026-11-18 from the feature worktree with `OPENROUTER_API_KEY` from `.env.local`, authorized by the user. Three calls to `POST https://openrouter.ai/api/v1/systemone` with model `typesafe/jev-1.14`. Total cost $0.000738.

| Call                                     | Request bytes | Status | Latency | Input tokens | `usage.cost` |
| ---------------------------------------- | ------------- | ------ | ------- | ------------ | ------------ |
| Command state, two noul questions        | 408           | 200    | 471 ms  | 334          | 0.000014028  |
| Small transcript, noul, score and choice | 1,668         | 200    | 228 ms  | 777          | 0.000032634  |
| 40 KB transcript, noul, score and choice | 41,152        | 200    | 305 ms  | 16,461       | 0.000691362  |

Response body of the first call, used as the test fixture:

```json
{
  "model": "typesafe/jev-1.14-20261014",
  "answers": {
    "reads_now": { "type": "noul", "noul": 0.09 },
    "stages_indirect": { "type": "noul", "noul": 0.06 }
  },
  "usage": {
    "input_tokens": 334,
    "output_tokens": 41,
    "cost": 0.000014028,
    "is_byok": false,
    "cost_details": {
      "upstream_inference_cost": 0.000014028,
      "upstream_inference_prompt_cost": 0.000014028,
      "upstream_inference_completions_cost": 0
    }
  },
  "id": "gen-dec-1795028963-g6NmQCJUz3cCNwDn4ZjZ",
  "provider": "TypeSafe"
}
```

Score answers carried `score`, `confidence`, `probabilities` and `legend`. Choice answers carried `choice`, `confidence` and `probabilities`.

## Acceptance criteria

| ID  | Given, when, then                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Check                                                                                                                                                                                                                                                                                                     | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1  | Given `OPENROUTER_API_KEY` is set, when `evaluate(state, questions)` runs, then it sends one `POST` to `https://openrouter.ai/api/v1/systemone` with `Authorization: Bearer <OPENROUTER_API_KEY>` and a JSON body of exactly `{ model: "typesafe/jev-1.14", state, questions }`. No request goes to `api.typesafe.ai`.                                                                                                                                                                                                                            | `tests/control.test.ts` with a `fetch` stub that records URL, headers and body. The expected URL and model are string literals in the test, not the imported constant.                                                                                                                                    | Passed |
| C2  | Given `OPENROUTER_API_KEY` is unset and `TYPESAFE_API_KEY` is set, when `evaluate` runs, then it rejects with `OPENROUTER_API_KEY is not set.` and sends no request.                                                                                                                                                                                                                                                                                                                                                                              | `tests/control.test.ts`.                                                                                                                                                                                                                                                                                  | Passed |
| C3  | Given the live response body recorded above, when `evaluate` parses it, then it returns both noul answers and `inputTokens` 334.                                                                                                                                                                                                                                                                                                                                                                                                                  | `tests/control.test.ts` with the recorded body as the stub response.                                                                                                                                                                                                                                      | Passed |
| C4  | Given a 400 response containing `max_tokens_exceeded`, then `evaluate` rejects with `TypesafeDocumentTooLargeError`. Given any other non-2xx response, then the error message carries the status and none of the body. Malformed answers, missing answers and invalid usage still reject.                                                                                                                                                                                                                                                         | Existing cases in `tests/control.test.ts`, kept. Added: the non-2xx case asserts the message does not contain the response body text, and the too-large case also runs with an OpenRouter-style body `{ "error": { "code": 400, "message": "…", "metadata": { "error_type": "max_tokens_exceeded" } } }`. | Passed |
| C5  | Given the integration fakes answer only on the new URL, and those that asserted a bearer token assert the OpenRouter one, when the classifier, worker, eval and submission scenarios run, then every scenario passes with no expected value changed except the URL, the bearer token and the model literal, including the two SQL literals that select classifier holds by model. A new run stores `monitor_model = "typesafe/jev-1.14"`. Each fake already fails on a URL it does not expect, which covers a stray request to `api.typesafe.ai`. | `npm run test:integration`, and a review of the test diff for any changed expectation.                                                                                                                                                                                                                    | Passed |
| C6  | No runtime or script code reads `TYPESAFE_API_KEY`, no test depends on it, and no code or current doc names `api.typesafe.ai/v1/systemone` as the endpoint. Live eval config requires only `OPENROUTER_API_KEY`.                                                                                                                                                                                                                                                                                                                                  | `git grep -n -e TYPESAFE_API_KEY -e 'api\.typesafe\.ai' -- lib app scripts tests .env.example README.md` returns only the C2 regression in `tests/control.test.ts`, which sets the old variable to prove it is ignored. `tests/monitor-investigate-eval.test.ts`.                                         | Passed |
| C7  | The offline gate passes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `npm run check`.                                                                                                                                                                                                                                                                                          | Passed |

## Implementation steps

1. In `tests/control.test.ts`, change the transport expectations to C1 through C4 and add the C2 and C3 cases. Run `npm test` and record that they fail because the code still calls TypeSafe.
2. In `lib/typesafe.ts`, change the URL, the key and the model constant, and update the header comment. Run `npm test`.
3. Update the fakes and literals in `tests/integration/*`, `tests/monitor-investigate-eval.test.ts` and `scripts/smoke.ts` to the new URL, bearer token and model id. Delete each classifier-only `TYPESAFE_API_KEY` override. Each file uses one `OPENROUTER_API_KEY` value that both its classifier fake and its investigator fake assert. That is the runner's `integration-router-key` unless the file already sets its own. Update the SQL literals `model='jev-1.14.0'` in `tests/integration/flag-read-baseline.test.ts` and `tests/integration/flag-read-production.test.ts`. In `scripts/smoke.ts`, drop the `api.typesafe.ai` half of the live allowlist.
4. Update `scripts/monitor-calibrate.ts`, `scripts/monitor-investigate-eval.ts` and `scripts/flag-read-semantic-assessment.ts` to check `OPENROUTER_API_KEY`. Add `TYPESAFE_MODEL` to the calibration cache key. In `scripts/flag-read-baseline.ts`, set the classifier pricing entry to `TYPESAFE_MODEL`, the source `https://openrouter.ai/api/v1/models/typesafe/jev-1.14/endpoints` and its own `checkedAt: "2026-11-18"`.
5. Remove `TYPESAFE_API_KEY` from `.env.example`. Update the README passages that name the key, the model location, the worker's required secrets or how classifier charges settle. Correct the two comments that describe direct-API limits, in `lib/typesafe.ts` and `lib/monitor-document.ts`. `lib/monitor-document.ts` changes in that comment only.
6. Run `npm run check` and `npm run test:integration`. Record results in the status column.

## Ownership

Owned paths: `lib/typesafe.ts`, `tests/control.test.ts`, `tests/monitor-investigate-eval.test.ts`, `tests/integration/*` files that fake the classifier transport, `scripts/smoke.ts`, `scripts/monitor-calibrate.ts`, `scripts/monitor-investigate-eval.ts`, `scripts/flag-read-semantic-assessment.ts`, `scripts/flag-read-baseline.ts`, `.env.example`, `README.md`, one comment in `lib/monitor-document.ts`, this plan.

Roles: lead is Claude Fable 5.2. Plan verifier and code reviewer are Claude Opus 5.5 at high effort, read-only. Developer is Claude Sonnet 5.5 at medium effort.

## Sources

- https://openrouter.ai/docs/guides/community/typesafe-sdk.md for the System One endpoint, authentication and model id mapping, read 2026-11-18.
- https://openrouter.ai/docs/guides/community/jev.md for the 32,000 byte long-context rule, read 2026-11-18.
- https://openrouter.ai/api/v1/models/typesafe/jev-1.14/endpoints for price and context length, read 2026-11-18.
- https://docs.typesafe.ai/models.md and https://docs.typesafe.ai/api/errors.md for direct-API limits and `max_tokens_exceeded`.

## Plan verification

Independent read-only review on 2026-11-18 returned approved with seven P2 changes and no P0 or P1 findings. All seven are applied above: the bounded reservation row label, single-key test setup, literal expectations in C1, proof that error messages omit the body, the calibration cache key, the run-stamp wording, and a testable definition of C5.

## Verification evidence

Run by the lead on 2026-11-18 in the feature worktree.

- Red: with the baseline `lib/typesafe.ts` restored under the new tests, `npx tsx --test tests/control.test.ts` failed 5 of 12. The failures were `TYPESAFE_API_KEY is not set.` in the cases that set only `OPENROUTER_API_KEY`, and the C2 case reaching the fetch stub. With only the key lookup changed, the transport test failed on `actual: 'https://api.typesafe.ai/v1/systemone'`. With the new client restored the file passed 12 of 12.
- C1 to C4 and C7: `npm run check` exited 0 with 388 tests passed and none failed. Baseline was 386. The two added tests are C2 and C3.
- C5: `npm run test:integration` exited 0 with 350 tests passed, none failed and none cancelled, in 94 seconds. The diff under `tests/integration/` changes only the classifier URL, the bearer token, the model literal and the key setup. No amount, token count, call count, verdict or retry expectation changed. `tests/integration/flag-read-eval.test.ts` dropped `integration-typesafe-key` from its leak-canary list because that key no longer exists. `integration-router-key`, now the classifier's key as well, remains in the list.
- C6: the grep above, extended to `deploy .github Dockerfile fly.toml`, returns four lines, all in the C2 test. `git grep -n "jev-1\.14\.0" -- lib app scripts tests` returns nothing.
- Development was done by the developer agent from the approved plan. Its first red run showed the key failures only. The lead reproduced the red state above.

## Code review

Independent read-only review of the full working-tree delta on 2026-11-18 found no P0, P1 or P2 issue and confirmed C1 to C7. The reviewer ran `npm run check` with 388 of 388 passing. Four P3 notes were applied: the C1 test asserts the method and a single call, the pin comment in `lib/typesafe.ts` states that the slug has no patch number, and two sentences in this plan were corrected. Two P3 notes stand: the OpenRouter-style too-large body in `tests/control.test.ts` was not recorded live, and the missing-key mapping in `scripts/flag-read-semantic-assessment.ts` has no test.

## Unrun checks

- `CTF_SMOKE_DISPOSABLE=1 npm run smoke` against real services. It now exercises the OpenRouter System One route through the runner and is the deployment contract check for this change.
- A live call at the 90 KB document cap.
- `scripts/flag-read-semantic-assessment.ts` maps the missing-key message and has no test for that mapping.

## Baseline integration note

The full `npm run test:integration` run at baseline failed on this machine: the `sprites.test.ts` parent test hit its 120 second timeout and ten later subtests failed on a closed pool. The machine's load average was about 10 from other sessions. `npm run test:integration -- tests/integration/sprites.test.ts` alone passed at baseline with 201 tests in 90 seconds.
