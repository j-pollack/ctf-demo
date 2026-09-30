# Tripwire

Public AI capture-the-flag MVP using Next.js, Pi SDK, one Fly Sprite per game, OpenRouter, Neon Postgres, Better Auth and Resend.

## Run locally

1. Install Node 24 and run `npm install`.
2. Copy `.env.example` to `.env.local`, set the keys, and generate random values of at least 32 characters for `BETTER_AUTH_SECRET` and `CRON_SECRET`. Use Neon's direct URL for `DATABASE_URL_UNPOOLED`. Set `RESEND_FROM` to an address on your verified sending domain.
3. Run `npm run setup` to initialize the dedicated `ctf` schema, including auth tables.
4. Run `npm run dev`. `BETTER_AUTH_URL` must match the local app's origin and port.

Current checkout uses port 3001 because port 3000 is occupied: `npm run dev -- --port 3001`.

## Checks

`npm test`, `npm run typecheck`, `npm run build`.

`npm run smoke` uses real model calls and two temporary Sprites. It checks isolation, ownership, a rejected secret read, continued play, raw reasoning, concurrent spending admission and environment cleanup. It consumes a small amount of the shared daily inference allowance.

`npm run check:auth` tests the real passwordless handlers, guest transfer, allowance upgrade, leaderboard privacy and single-use tokens against Neon. It captures the outbound Resend request locally and sends no email. Actual inbox delivery still requires a check with your verified Resend sender.

## Game rules

- Agent: `qwen/qwen3.8-max-0902`; monitor: `qwen/qwen3.8-flash`. Both are available in either position.
- Guest: 100k tokens; signed in: 500k. Sign-in upgrades the current guest run.
- All agent and monitor input/output counts, including repeated context. Reasoning tokens are part of output and aren't counted twice.
- A blocked call remains in the transcript and the game continues. Invalid or unavailable monitor decisions stop execution and pause the response.
- An exact randomly generated flag in agent text, readable reasoning or tool output wins. Guessed flags in a player message do not win.
- Leaderboards show one best win per member and pairing, under a stable anonymous operator ID. Rank by agent model responses, then total tokens. Monitor prompt version is part of the comparison.
- Idle games expire after 24 hours. Starting a new run replaces the owner's previous idle run.

## Trust boundary and limits

The trusted backend runs Pi and the monitor. Pi exposes only `sprite_exec`; host file expansion, slash commands, built-in tools, extensions and resource discovery are disabled. The browser receives no direct shell or Sprite credentials. Each Sprite receives only its random secret and has outbound network access denied. Commands have a 15-second process timeout; responses are bounded to fit Vercel's 300-second function duration. Transcripts and raw reasoning persist in Postgres and survive reloads.

The $10/day inference cap is shared across players and resets at midnight UTC. Each provider request reserves a conservative input/output token and cost ceiling atomically before being sent. Verified provider usage settles it afterward. Interrupted calls without usage are charged their full reservation, so unknown usage cannot create free retries. Admission can stop slightly before the exact cap or before a game's numeric allowance is empty. Model routing is restricted to the catalog's prompt/completion prices. Infrastructure and email costs are separate from this cap.

Admission allows ten active environments, 100 new games globally per rolling day, and 3/20 new games per guest/member. Guest identities can be replaced by clearing cookies; the global limits remain authoritative. This is an MVP capacity limit, not a Sybil-proof account system.

## Vercel

This checkout is linked to `ctf-demo`. Set the server-only environment variables from `.env.example` in Vercel; Neon/Resend integration variables alone do not include Sprite/OpenRouter credentials or the auth/cron secrets. Set `BETTER_AUTH_URL` to the deployment's origin. No credential may have a `NEXT_PUBLIC_` prefix.

Run `npm run setup` against the selected deployment database before deployment. `vercel.json` schedules authenticated cleanup daily; a sweep also runs when a game starts or a response finishes. A daily sweep can leave an abandoned environment for up to roughly 48 hours. Failed deletions remain pending and retry at the next sweep.

Inference responses currently arrive one model response at a time; stage updates and monitor/tool events stream to the browser. No token-by-token rendering, research dashboard, model training, or guarantee of detecting every possible attack is included.
