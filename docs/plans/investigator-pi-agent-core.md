# Investigator on pi-agent-core

- Worktree: `/Users/jonathan/Code/ctf/.worktrees/investigator-pi-agent-core`
- Branch: `feat/investigator-pi-agent-core`, from `main` at `911043d`
- Baseline: HEAD `911043d`, clean working tree, empty index. No pre-existing changes.
- Authorization: edits in this worktree, offline checks, `npm install` of the one dependency below. No commits, pushes, PRs, deploys, paid/live model calls, shared databases or `.env.local`.

## Goal

The Fly monitor worker (`scripts/monitor-worker.ts`) loads `@earendil-works/pi-coding-agent` only to wrap pi-agent-core's `Agent` for the flag-read/monitor investigator. pi-coding-agent ships an `npm-shrinkwrap.json`, so it brings its own copies of pi-ai, pi-agent-core and typebox plus TUI, MCP, undici, highlight.js and others. Build the investigator on `Agent` from `@earendil-works/pi-agent-core` directly so the worker graph never loads pi-coding-agent.

## Scope

Owned files:

- `package.json`, `package-lock.json`: add `@earendil-works/pi-agent-core` at `^0.99.1`, locked to `0.99.1`.
- `lib/investigator-driver.ts`: replace `createIsolatedInvestigatorSession` with `createInvestigatorAgent`.
- `lib/monitor-review.ts`: re-export the new name instead of the old one.
- `lib/transcript-search.ts`, `lib/monitor-evidence.ts`, `lib/monitor-tools.ts`, `lib/transcript-query.ts`, `lib/flag-read-chain.ts`, `lib/flag-read-investigator.ts`: `defineTool`/`ToolDefinition` become pi-agent-core's `AgentTool`. Types only, plus dropping the unused fifth `context` argument that `withReadEvidenceChain` forwards.
- `next.config.ts`: add `@earendil-works/pi-agent-core` to `serverExternalPackages` beside pi-ai and pi-coding-agent. Web routes reach `investigator-driver` through `lib/sessions.ts` → `lib/monitor-review.ts`, so the package enters the server bundle.
- `tests/monitor-review.test.ts`: use the new constructor and `AgentTool`; assert the provider-visible loadout with pi-ai's `getCurrentTools(agent.state.messages)` instead of `getActiveToolNames()`.
- Tests that call `tool.execute(..., {} as never)` with a fifth argument drop it: `tests/flag-read-chain.test.ts:41,167,203`, `tests/flag-read-investigator.test.ts:48,142,179`, `tests/integration/transcript-query.test.ts:132,152,266`, `tests/integration/flag-read-corpus-twin.test.ts:120`, `tests/integration/transcript-evidence.test.ts:214`, `tests/monitor-review.test.ts:428`. `tests/flag-read-chain.test.ts:155-168` asserts the forwarded tuple; it becomes the four-item tuple because the fifth `ctx` argument no longer exists.
- `tests/integration/monitor-eval.test.ts`: replace the assertion that a `<cwd>` system message appears (see D3); remove `continuationCwdSeen` and the now-unused `tmpdir` import.
- `tests/integration/flag-read-reliability-helper.ts:126-134`: assert exactly one system message, equal to the selected prompt (D3).
- This plan.

Non-goals:

- Player runners (`lib/runner-async.ts`, `lib/runner-session.ts`) and `tests/message-flow.test.ts` stay on pi-coding-agent. pi-coding-agent stays a dependency.
- No change to `query_transcripts` beyond its tool type (a sibling investigation owns its fate).
- No typebox version change. PR #33 pins `typebox` to `1.3.27`; expect a trivial `package.json`/lock conflict with it.
- No forked or hand-written agent loop, no Dockerfile change, no bundling.

## Findings that shape the design

Baseline capture: `scratchpad/capture-investigator-contexts.ts` (full path below) runs a three-call investigation (read_transcript, schema-invalid finish_review, valid finish_review) through the real Agent and records each context handed to the stream function, the provider-visible transcript (`providerTranscript`), the event sequence and the final decision. Baseline output: `baseline-contexts.json`.

1. `agentStream` (`lib/inference.ts:634`) uses only `context.messages` and `options.signal`. Model, effort, token limits and routing come from `TrustedInferenceOptions`. The session layer's request options (`sessionId`, `transport`, `thinkingBudgets`, `maxRetryDelayMs`, header transforms, cache warmer, `modelRuntime.streamSimple`) never reach a provider because the driver replaces `agent.streamFunction`.
2. The provider sees tools through a system message's `toolsAdded`. pi-ai's `createInitialSystemMessage(systemPrompt, tools)`, which `new Agent({ initialState: { systemPrompt, tools } })` calls, produces one system message with `content: systemPrompt` and `toolsAdded`. pi-coding-agent produced two: `{content: "", sections: {preamble}}` and `{content: "", toolsAdded}`, which the provider transcript renders as the prompt followed by an empty system message.
3. After the first tool turn, pi-coding-agent's `prepareNextTurnWithContext` appends a system message `<cwd>\n<tmpdir>/tripwire-monitor-XXXX\n</cwd>` from its temporary working directory. The worker's temp path leaks to the investigator model and makes the payload nondeterministic. `tests/integration/monitor-eval.test.ts:161-167,367` requires that message to appear; `tests/integration/flag-read-reliability-helper.ts:127` only tolerates it.
4. Session hooks with no extensions loaded are no-ops for these text-only tools: `beforeToolCall`, `afterToolCall` (image normalisation), `finishTurn`, `transformContext`; compaction and retry are disabled; `prepareRequest` rebuilds messages from the in-memory session, equal to the agent's own.
5. Tool execution: `Agent.toolExecution` defaults to `"parallel"` in both cases; every investigator tool sets `executionMode: "sequential"` and that must survive. `wrapToolDefinition` copies `name, label, description, parameters, outputSchema, constrainedSampling, prepareArguments, executionMode, execute`; the investigator tools use no other `ToolDefinition` fields, and only `withReadEvidenceChain` touches the fifth `ctx` argument (by forwarding it).
6. Thinking level: the session clamped `"high"` against the model; the value only becomes `options.reasoning`, which `agentStream` ignores. Use `INVESTIGATOR_EFFORT` unclamped.
7. Tool schema validation (`Validation failed for tool "<name>":`) comes from pi-ai's `validateToolArguments` inside pi-agent-core's loop, which the driver's schema-error recovery depends on. Unchanged.
8. `session.dispose()` and the `mkdtemp` directory exist only for the session layer. A bare `Agent` holds no resources after `prompt()` settles.
9. pi-agent-core `0.99.2` exists and needs pi-ai `^0.99.2`; installing it would add a second pi-ai. Lock `0.99.1` to match pi-ai.
10. Worker import graph at baseline (esbuild metafile from `scripts/monitor-worker.ts`): `investigator-driver`, `monitor-tools`, `transcript-search`, `monitor-evidence`, `transcript-query` import pi-coding-agent values; `flag-read-chain` and `flag-read-investigator` import its types.

## Decisions

- D1. `createInvestigatorAgent(model, tools: AgentTool[], streamFn, systemPrompt = INVESTIGATOR_SYSTEM_PROMPT): Agent` returns `new Agent({ initialState: { systemPrompt, model, thinkingLevel: INVESTIGATOR_EFFORT, tools }, streamFn })`. It is synchronous and has no dispose. The driver builds the guarded stream before the agent and passes it in; `recordFailure` and the abort listener call `investigator?.abort()`.
- D2. Tools are typed as `AgentTool` from `@earendil-works/pi-agent-core`. Keep each tool's fields and behavior. pi-agent-core has no `defineTool`, and an untyped literal inside `AgentTool[]` makes `execute` params `unknown`. Annotate each tool as `const name: AgentTool<typeof schema> = {...}` (hoisting the schema into a named constant where needed) so params stay typed from the schema. No new helper, no `any` or casts that hide a type mismatch.
- D3. The provider-visible transcript intentionally loses the empty second system message and the `<cwd>` message (findings 2, 3). Everything else the provider sees must be identical. Each request shrinks by about 120 bytes against `maxContextBytes`. `monitor-eval.test.ts` changes from "a later cwd system message appears" to `assert.deepEqual(systems.map((s) => s.content), [INVESTIGATOR_SYSTEM_PROMPT])` on every request, the stricter form of the property the old assertion protected (no extra instructions reach the investigator). The reliability helper's `.every` over later system messages passes vacuously, so it also asserts exactly one system message. The investigator's model input differs from what `docs/plans/investigator-reliability.md` measured live; no live eval is rerun (unauthorized), and the PR must say so.

## Criteria

| ID  | Given / when / then                                                                                                                                                                                                                                                                                                                                                                                                                                   | Check                                                                                                                                                                                                                                                                                                                                                                 | Evidence / status |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| C1  | Given the worker entry, when its import graph is resolved, then no owned file imports `@earendil-works/pi-coding-agent` (value or type).                                                                                                                                                                                                                                                                                                              | `node scratchpad/worker-graph.mjs` reports `piCodingAgentImporters: []`; `grep -n pi-coding-agent` over the files listed under Scope (lib only) is empty.                                                                                                                                                                                                             | pending           |
| C2  | Given the worker module graph loaded the way `scripts/monitor-worker.ts` loads it, then no pi-coding-agent file is resolved and exactly one pi-ai copy is resolved.                                                                                                                                                                                                                                                                                   | `node --expose-gc --import tsx scratchpad/measure-worker.mjs` prints `piCodingAgentLoaded: false` and one `pi-ai` key.                                                                                                                                                                                                                                                | pending           |
| C3  | Same load, then RSS after GC drops versus baseline.                                                                                                                                                                                                                                                                                                                                                                                                   | Same command, 3 runs each, same Node (`v25.6.0`) on this machine. Baseline: 240.3, 226.2, 230.5 MB RSS; 3,028 resolved files. Report all runs. Target: a clear drop (verifier's scratch estimate 50-75 MB); no fixed threshold, report the number. Node 25.6 here versus `node:24-slim` in the image: valid as a before/after comparison, not as a production figure. | baseline recorded |
| C4  | Given the scripted three-call investigation, when run on the new agent, then every provider transcript equals the baseline's except for the removed empty system message and `<cwd>` message; tool list, tool results (including the `Validation failed for tool "finish_review":` text), event sequence apart from the removed system message events, `executionMode: sequential` on every tool, `thinkingLevel: high` and the final decision match. | Rerun the capture script on the new code; a scripted comparison filters the baseline's empty and `<cwd>` system messages (and their message_start/end events), then deep-equals the rest; the lead reads the residual diff.                                                                                                                                           | baseline recorded |
| C5  | Existing investigator behaviour holds: first valid finish aborts the remaining batch; retrieval tool errors abort before another request; invalid citation fails before a decision; call/context limits; cancellation/deadline.                                                                                                                                                                                                                       | `npm test` (includes `tests/monitor-review.test.ts`, `tests/flag-read-*.test.ts`, `tests/monitor-tools.test.ts`).                                                                                                                                                                                                                                                     | pending           |
| C6  | Provider payloads through the real worker/orchestration path with a fake OpenRouter carry the prompt as the only system message and the expected tools.                                                                                                                                                                                                                                                                                               | `npm run test:integration` (disposable Docker Postgres; needs the local `postgres:17-alpine` image), including the updated `monitor-eval.test.ts` and the reliability helper.                                                                                                                                                                                         | pending           |
| C7  | Repo gates pass, including the production build.                                                                                                                                                                                                                                                                                                                                                                                                      | `npm run check` (lint, format, typecheck, unit tests) and `npm run build` with the CI dummy env from `.github/workflows/ci.yml:41-46` (no real credentials).                                                                                                                                                                                                          | pending           |
| C8  | Player runners unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                             | `git diff --stat` touches no `lib/runner-*.ts`; `tests/message-flow.test.ts` passes in `npm test`.                                                                                                                                                                                                                                                                    | pending           |
| C9  | `package.json` gains exactly one dependency line; the lock adds pi-agent-core `0.99.1` and only its own dependency tree (expected: `@earendil-works/chord`, `diff`, `ignore`, nested `yaml` 2.9.0 and `typebox` 1.3.27, and whatever chord needs); no existing top-level version changes.                                                                                                                                                             | `git diff package.json`; `git diff package-lock.json` reviewed for added vs changed entries; `npm ls @earendil-works/pi-ai @earendil-works/pi-agent-core` shows pi-ai `0.99.1` deduped under pi-agent-core.                                                                                                                                                           | pending           |

Failure cases covered: tool error abort, invalid finish arguments and recovery, call-limit, context-limit, cancellation and deadline (C5); provider payload shape (C4, C6).

## Steps

1. Install: `npm install --save @earendil-works/pi-agent-core@0.99.1`; add it to `next.config.ts` `serverExternalPackages`. Verify C9.
2. Retype tools (D2) in `transcript-search`, `monitor-evidence`, `monitor-tools`, `transcript-query`, `flag-read-chain`, `flag-read-investigator`. Verify: `npx tsc --noEmit` after step 3.
3. Replace the session constructor (D1) in `investigator-driver.ts`; update `monitor-review.ts` re-export, `tests/monitor-review.test.ts` and the five-argument `execute` calls in tests. Verify C4 (capture diff) and C5.
4. Update `monitor-eval.test.ts` and `flag-read-reliability-helper.ts` (D3). Verify C6.
5. Verify C1, C2, C3, C7, C8.

The step-3 change is a refactor bracketed by the existing passing tests (C5) and the before/after capture (C4); the only intended behaviour change is D3, which the updated integration assertion pins.

Scratch tools (outside the repo): `/private/tmp/claude-501/-Users-jonathan-Code-ctf/54adfa86-3f1e-43f4-8271-ba3d9325b1d5/scratchpad/{capture-investigator-contexts.ts,baseline-contexts.json,worker-graph.mjs,measure-worker.mjs}`. The capture script runs from the worktree root after `cp` to `.capture.tmp.ts` (delete it afterwards); it detects the new `createInvestigatorAgent` export and will need its call updated to pass the stream function (D1).

## Plan verification

Independent verifier (opus, high effort, read-only): approve with changes.

- B1 (blocking): five-argument `execute` calls in five more test files, and the forwarding assertion in `tests/flag-read-chain.test.ts`. Resolved: added to Scope.
- B2 (blocking): `npm run build` unverified and pi-agent-core missing from `serverExternalPackages`. Resolved: `next.config.ts` in Scope, build in C7.
- N1: typed literals lose param types. Resolved: D2 names the annotation approach.
- N2: session-layer enumeration confirmed complete; `new Agent` requires `streamFn`, as D1 has it.
- N3: stricter assertions for both integration helpers; lint cleanup. Resolved in Scope and D3.
- N4: C9 now lists the expected additions. Three typebox copies remain until PR #33.
- N5: tool-loadout assertion via `getCurrentTools`; scripted C4 comparison. Resolved.
- N6 (committed import-graph guard test): declined. It adds an esbuild-dependent test for a one-off property; C1/C2 prove it now. Can be added if the user wants regression protection.
- N7: Node version caveat noted in C3.

## Checkpoints

No commits are authorized. Verified states are recorded here instead.

## Verification log

Lead-run results on the uncommitted tree (developer results matched). `S` is the scratchpad directory listed under Steps.

- C1: `node $S/worker-graph.mjs` reports `piCodingAgentImporters: []`; externals are pi-agent-core, pi-ai, @fly/sprites, pg, typebox and node builtins. `grep pi-coding-agent` over the eight owned lib files finds nothing.
- C2/C3: `node --expose-gc --import tsx $S/measure-worker.mjs`, Node v25.6.0, three runs: 145.2, 145.4, 145.3 MB RSS, 2,018 resolved files, `piCodingAgentLoaded: false`. Baseline: 240.3, 226.2, 230.5 MB, 3,028 files. One pi-ai copy (top level). Three typebox copies load: top-level 1.3.34, pi-ai's nested 1.3.27 and pi-agent-core's nested 1.3.27.
- C4: `node $S/compare-c4.mjs` (baseline vs `after-lead.json`): provider transcripts of all four calls equal the baseline with its empty and `<cwd>` system messages removed. Tools, option keys, reasoning `high`, non-system messages, non-system events, `stateTools` (all `sequential`), `toolExecution: parallel`, final messages and decision are equal. The new agent emits no system message events; baseline emitted two pairs.
- C5/C7/C8: `npm run check`: lint clean, format clean, typecheck clean, 386/386 tests pass. No `lib/runner-*.ts` in the diff.
- C7 build: `npm run build` under `env -i` with the CI dummy values and every other `.env.local` key set empty, so Next could not fall back to the worktree's `.env.local`: build succeeds.
- C9: `package.json` adds one line. The lock adds pi-agent-core 0.99.1, chord 0.99.2, diff 8.0.4, ignore 7.0.8, nested yaml 2.9.0 and nested typebox 1.3.27. It also drops `"dev": true` from esbuild 0.28.2 and its platform packages, because chord depends on esbuild at runtime. No version changes. `npm ls`: pi-ai 0.99.1 deduped under pi-agent-core.
- C6: `npm run test:integration` (disposable Docker Postgres): 350/350 pass, exit 0, including `monitor-eval.test.ts` with the single-system-message assertion and the reliability helper's strategies.

## Review

Independent reviewer (opus, high effort, read-only) found no P0-P2 issues and judged C1-C9 met. P3 notes:

- Mid-run cancellation of the driver has no test. This gap predates the change; the new ordering puts no `await` between `prepare` and agent creation.
- The PR body must state the dependency effects: chord resolves to 0.99.2 and esbuild loses `"dev": true`, though esbuild never loads at runtime and the image already installs dev dependencies. It must also state the D3 input change and that the live eval was not rerun.
- Tests build the agent with a throwing placeholder stream and then assign `streamFunction`. Left as is; it has no correctness impact.

No corrective cycle was needed. The simplification pass was skipped because no concrete in-scope improvement remained.
