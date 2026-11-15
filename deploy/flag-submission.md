# Flag submission endpoint

New HTTP runs upload raw flag bytes to `POST /v1/end` on the app's public HTTPS origin. `SITE_URL` is this app's optional origin override, not a Vercel-provided variable. The backend derives the endpoint from it when set. Leave it unset on Vercel to use the system variables below. On Vercel production it otherwise uses `VERCEL_PROJECT_PRODUCTION_URL` when available, then the immutable `VERCEL_URL`. Previews use their immutable `VERCEL_URL`. An invalid selected value fails closed. Request headers do not choose the destination. The selected hostname is the only egress host permitted for new HTTP Sprite runs. The command receives the endpoint as `TARGET` and a short-lived `CTF_SUBMISSION_TOKEN`. The route requires the token and matching run ID before admitting a receipt.

## Local ngrok tunnel

Run the app on port 3001, then start a tunnel to that same local app:

```sh
ngrok http 3001 --inspect=false
```

Read the actual HTTPS forwarding origin from ngrok's output. Set `SITE_URL` to that origin in the local app's `.env.local`, with no path. Restart the app and confirm that its landing, rules and play screens show the derived `/v1/end` URL. Do not use `localhost`, a guessed ngrok hostname, a Vercel preview connected to another database, or the tunnel's inspection interface as the Sprite target. Keep the tunnel and app running while HTTP commands may still execute.

The current free ngrok account has an account-wide limit of 4,000 HTTP requests per minute. It does not provide the planned path-specific 30 requests per 60 seconds per IP rule: ngrok rejected that Traffic Policy with `ERR_NGROK_2263`. Do not claim a local path-specific `429` test. The route's bearer, run ID, request size and time limits remain required. On Vercel, a WAF rule limits `/v1/end` to 30 requests per 60 seconds per IP. Prove its `429` against a deployed `/v1/end` before production promotion.

If the tunnel hostname changes, inventory all nonterminal HTTP runs, including idle runs with no active commands. Wait for affected commands to finish, then retire or replace affected owned runs through normal lifecycle controls before changing `SITE_URL`. If an old-target run is retained, do not resume it after the change; start a fresh run with the new hostname. Restart the app after changing `SITE_URL`. A retained run keeps its old Sprite policy and cannot be migrated by changing the app setting. The free tunnel hostname is not assumed stable.

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

The full smoke requires an empty, isolated database. It adds `sslmode=verify-full` if the URL has no TLS query and rejects weaker or unrelated query options. It checks public GET `405` and unauthenticated POST `401` at `/v1/end`. It creates one tagged Sprite, applies exact-host allow plus deny-all policy, restores a checkpoint and reads the policy again. It requires GET `405` from the Sprite and an explicit DNS or connection refusal for the unrelated control. A timeout fails the smoke. It writes a synthetic flag file on the Sprite and uploads its raw bytes using `TARGET`, without printing the flag or bearer. It checks response loss, exact replay, one correct durable receipt and late replay after dispatch completion. It deletes only its own rows and Sprite, including after failure. The script calls no model service.

For a local tunnel proof without database writes, use a separate bounded probe of public GET `405`, unauthenticated POST `401`, Sprite allow and deny policy, and policy restoration. Do not run the full smoke against the shared local database.

## Deployment and rollback

The public receiver must reach the same app and database that own the run. Before changing an active origin or route, stop new HTTP run creation and retire or replace affected nonterminal runs with a compatible worker. A Sprite hostname policy does not isolate the HTTP path or services sharing that hostname or IP address. Production promotion requires separate real receiver, rate-limit and Sprite checks. The local free ngrok cap is weaker than the planned Vercel WAF rule.
