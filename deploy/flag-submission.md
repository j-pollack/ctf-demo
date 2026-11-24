# Flag submission endpoint

Each command receives a `TARGET` URL for uploading a UTF-8 body to `POST /v1/end/<token>`. The receiver accepts bodies from 1 to 8,192 bytes. The selected hostname is the only egress host permitted for a new HTTP Sprite run.

`SITE_URL` overrides the public HTTPS origin. Without it, Vercel production first tries `VERCEL_PROJECT_PRODUCTION_URL`. Production and previews then use `VERCEL_BRANCH_URL` when available, falling back to `VERCEL_URL`. A branch hostname survives a new preview deployment. An invalid selected origin prevents new runs from starting.

The path token identifies the command and its run. Anyone holding it can make the first submission while that run is active, even after the command ends. The receiver records one submission per run. A `202` acknowledges receipt regardless of whether the flag is correct. Replaying the same token and body returns `202` without creating a second receipt, including after finalization. A different body or another valid token for that run returns `409` once a receipt exists. A first submission to an inactive run also returns `409`. A missing or unknown token returns `401`.

Treat request paths as credentials. Vercel and `next dev` request logs can capture them. The local tunnel starts with `--inspect=false` to disable ngrok inspection.

## Local ngrok tunnel

`npm run dev` starts `ngrok http <port> --inspect=false` for the app's port and passes the tunnel's HTTPS origin to the app and the monitor worker as `SITE_URL`, printed as `Site URL:` at startup. It overrides any `SITE_URL` in `.env.local`. To use another tunnel, export `SITE_URL` in the shell before `npm run dev`; ngrok is then skipped. If ngrok is missing or fails, the dev server prints why and starts without a site URL, and new runs report the endpoint as unavailable. Stopping `npm run dev`, or losing the tunnel, stops all three processes. The free account allows one ngrok agent at a time, so only one checkout can run with a tunnel.

During rollout, ngrok rejected the path-specific rate policy on the free account with `ERR_NGROK_2263`. Its account-wide limit does not verify per-IP protection. Configure Vercel’s WAF to limit `/v1/end` and its subpaths to 30 requests per 60 seconds per IP. Verify a deployed `429` before promotion.

If the tunnel hostname changes, inventory all nonterminal HTTP runs, including idle runs with no active commands. Wait for affected commands to finish, then retire or replace affected owned runs through normal lifecycle controls before restarting `npm run dev` with a new tunnel. If an old-target run is retained, do not resume it after the change; start a fresh run with the new hostname. A retained run keeps its old Sprite policy and cannot be migrated by changing the app setting. The free tunnel hostname is not assumed stable.

## Opt-in full receipt smoke

`node --import tsx scripts/flag-submission-smoke.ts` is opt-in. Supply all values explicitly, without loading `.env.local`:

| Variable                  | Value                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| `CTF_SMOKE_DISPOSABLE`    | `1`                                                                        |
| `CTF_SMOKE_DATABASE_URL`  | Direct URL for an empty, migrated `ctf_smoke_*` database with verified TLS |
| `CTF_SMOKE_DATABASE_NAME` | Exact database name from that URL                                          |
| `SITE_URL`                | Exact public HTTPS origin under test                                       |
| `CTF_SMOKE_CONTROL_URL`   | Unrelated operator-owned public HTTPS URL returning `200`                  |
| `SPRITE_TOKEN`            | Credential for disposable test Sprites                                     |

The full smoke requires an empty, isolated database. It adds `sslmode=verify-full` if the URL has no TLS query and rejects weaker or unrelated query options. It checks public GET `405` and unauthenticated POST `401` at `/v1/end`. It creates one tagged Sprite, applies exact-host allow plus deny-all policy and reads the policy back. It requires GET `405` from the Sprite and an explicit DNS or connection refusal for the unrelated control. A timeout fails the smoke. It writes a synthetic flag file on the Sprite and uploads its raw bytes to `TARGET` with no extra headers, without printing the flag or token. It checks response loss, exact replay, one correct durable receipt and late replay after dispatch completion. It deletes only its own rows and Sprite, including after failure. The script calls no model service.

For a local tunnel proof without database writes, use a separate bounded probe of public GET `405`, unauthenticated POST `401`, and Sprite allow and deny policy. Do not run the full smoke against the shared local database.

## Deployment and rollback

The public receiver must reach the same app and database that own the run. Before changing an active origin or route, stop new HTTP run creation and retire or replace affected nonterminal runs with a compatible worker. A Sprite hostname policy does not isolate the HTTP path or services sharing that hostname or IP address. Production promotion requires separate real receiver, rate-limit and Sprite checks.
