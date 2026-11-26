# Capture the flag

Capture the flag is an AI red-teaming game. You direct an agent in a Fly Sprite while a monitor reviews its work. The Next.js app streams the agent’s text, reasoning and tool activity as it plays. Sessions in the same run share a Sprite and a flag.

## Run locally

1. Install Node 24 and run `npm install`.
2. Copy `.env.example` to `.env.local`. Supply your development Postgres URLs, OpenRouter key, Sprite token and Resend key. The `CTF_` variables at the end set the defaults for the limits an admin can change and need no edit locally. Deployments require them, and the [operations guide](deploy/operations.md) lists them. Use the direct Neon URL for `DATABASE_URL_UNPOOLED` and a verified sender for `RESEND_FROM`. Generate separate random secrets of at least 32 characters for `BETTER_AUTH_SECRET` and `CRON_SECRET`.
3. Check which database those URLs select, then run `npm run setup`. Setup applies the game and authentication migrations to that database. Feature worktrees can share development credentials.
4. Run `npm run dev` and open the printed **Dev URL**. The launcher selects a port starting at 3001, sets the local auth origin, and starts the app and monitor worker. Set `PORT` in the shell to request a specific port.

For playable runs, install and configure ngrok so the launcher can open an HTTPS tunnel to the app. To use an existing public HTTPS origin forwarding to this checkout, export `SITE_URL` in the shell before starting the launcher. The launcher overrides the value in `.env.local`. Without a reachable submission endpoint you can browse the app, but new runs need the tunnel or another valid origin. [Flag submission setup](deploy/flag-submission.md)

## Play a run

Sign in by email magic link and choose a display name. By default members can start three runs per rolling 24 hours. Admins are exempt from this personal quota. The default $0.50 player budget covers the agent and live text screening. The investigator has a separate allowance. A run can have up to eight sessions. An admin can change these values, the shared daily cap, the session limit and other limits at `/admin`. The [operations guide](deploy/operations.md) gives the bounds and when a change takes effect.

Tell your agent how to submit the flag. Each Sprite command receives the HTTPS submission address in `TARGET`. The first well-formed upload uses the run’s submission attempt, even if the value is wrong. A capture requires the correct flag and clearance from the monitor, which checks for evidence that the agent read the flag. With **Bug fix required** enabled (the default), the agent must also fix at least one of the Bottle bugs listed in `/workspace/TASKS.md` and pass its check. The run keeps the game rules in effect when it started.

The leaderboard shows each member’s cheapest eligible capture by agent spend, with fewer agent responses breaking ties. Entries must match the current rules and monitor version and have settled billing. Players appear under their chosen display names, with a generated label for older accounts without one.

## Development and checks

Run `npm run check` for lint, formatting, TypeScript and offline tests. Run `npm run build` separately to check the production bundle.

- [Verification](docs/verification.md) covers Docker prerequisites, integration tests, coverage and opt-in live checks.
- [Contributor instructions](AGENTS.md) cover feature worktrees, repository skills and testing policy.
- [Deployment and operations](deploy/operations.md) covers migrations, Vercel promotion, Fly workers, rollback and admin access.
