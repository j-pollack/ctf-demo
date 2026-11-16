# HTTP ingress staging rollout

Historical record of the abandoned dedicated-ingress rollout. Nothing here is current. The current contract is [flag-site-target.md](flag-site-target.md).

## Agreement and current state

- Checkout: `/Users/jonathan/Code/ctf/.worktrees/flag-http-submission`, branch `feat/flag-http-submission`.
- Feature baseline: `fae20d4aace576358d08ce199e7834696b1fb3a4`. Existing approved uncommitted feature is preserved. Primary checkout stays unchanged.
- The user authorized dedicated ingress configuration and real Sprite validation. This permits scoped staging infrastructure and disposable test data, not production database/app changes, shared-user mutations or paid model evaluation.
- No commits, merge or push are requested. The user explicitly selected a retained 256 MB trial after reviewing the resource proposal. No further generic hosting approval is required.
- Same `gpt-6-astra` high lead and independent verifier. Scoped configuration developer uses `gpt-6-sol` high.
- Apply the Neon/Postgres branching skills for a disposable schema-only branch. Keep the existing driver and auth implementation.

## Observed prerequisites

Fly and Vercel CLI authentication work. Fly personal organization contains existing monitor worker apps. Vercel manages DNS for `jonathanpollack.net`; its existing `ctf` record points to the production web app and must not change. Neon project `ctf-demo` is accessible. Its production and shared `vercel-dev` branches are not test targets.

Proposed dedicated staging names are Fly app `ctf-flag-ingress-stage` and `flags-stage.ctf.jonathanpollack.net`. Read-only DNS inspection found no explicit record at that name. The final allocation remains pending.

Root now owns the user-authorized development server in this feature checkout on port 3001. The original user server was stopped with permission. The local environment does not define `FLAG_SUBMISSION_URL`. Run creation validates that setting before paid provisioning. Root authenticated the isolated browser using the user-authorized login link and reproduced Start run returning a generic HTTP 503. The user supplied the matching server log. A missing endpoint throws before provisioning and the route maps the ordinary error to that misleading retry message. No run or Sprite is created. Synthetic component screenshots did not prove the start-run path. This is a verification lesson, not a reason to restore the old tool or broaden egress.

## Selected topology

One Fly Machine exposes only raw TCP 443, with `handlers=[]`, a dedicated IPv4 and dedicated IPv6. No shared IPv4, Fly HTTP/TLS routing, HTTP port 80, UDP service or other public port is configured. Nginx terminates TLS on internal port 8443 and proxies the sole accepted operation to the Node ingress on loopback. Unknown or absent SNI fails the TLS handshake. Host, raw path/query and method are checked independently. CONNECT, upgrades, redirects and user-selected upstream routing are forbidden.

Use a real certificate for the owned hostname, obtained through external DNS-01 issuance. No ACME route is exposed on the ingress. Keep keys out of source, build layers and logs. Document bounded external renewal and atomic secret replacement. A single Nginx shared-memory limiter covers the one instance and returns 429 before upstream admission. No access/body logging. Body and request durations remain bounded.

The ingress database role can inspect and lock only receipt admission fields and insert receipts. PostgreSQL row locks require UPDATE privilege: grant only UPDATE(id) on games, agent_sessions and sprite_operations, together with owner-installed BEFORE UPDATE triggers that reject every actual UPDATE executed by the ingress role. SELECT FOR UPDATE does not fire an UPDATE trigger. The role owns no tables/functions, has no membership or schema CREATE rights, and cannot disable the guards. Test locks and successful receipt admission plus denied id=id updates, other column writes, schema changes, deletion and receipt mutation. This avoids broad UPDATE grants or changing application lock semantics. Use an isolated schema-only Neon branch, a dedicated `ctf_smoke_*` database and synthetic fixtures. No existing user data is copied. Only the explicit Sprite credential is selected from the authorized local secret source; do not load the entire environment into tests or containers.

The user selected a 256 MB SJC trial despite measured local idle memory near 227.5 MiB. Current region-adjusted compute plus dedicated IPv4 is about $4.62 per month plus traffic. IPv6 is free. Record idle, authenticated upload and bounded burst memory, OOM events and process/Machine restarts. If capacity fails, stop promotion and report before changing the size. Temporary controls/Sprites must be scoped and removed after validation. The main ingress may be retained under the user's explicit 256 MB choice. No automatic upsizing is authorized.

## Acceptance and evidence

| ID    | Given / when / then                                                                                                                                                                                                                              | Check and current status                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-01 | Given staging configuration, when built and started with synthetic TLS/database settings, then only the exact HTTPS operation reaches the loopback handler; invalid authority, SNI, path/query, method, upgrade and proxy requests are rejected. | Real local Docker/Nginx/Node/Postgres integration; not run.                                                                                                                                                                                            |
| FR-02 | Given a burst of valid-shaped requests, when the shared edge limit is exceeded, then 429 has no-store and rejected requests produce no upstream receipt work.                                                                                    | Local deterministic edge check, then staging proof; not run.                                                                                                                                                                                           |
| FR-03 | Given restricted ingress credentials, when requests create/retry a receipt, then they work; unrelated writes, schema changes and receipt mutation are denied.                                                                                    | Real disposable Postgres privilege assertions; not run.                                                                                                                                                                                                |
| FR-04 | Given the deployed ingress and real Sprite, when policy is applied/read back and restored, then file upload and exact replay succeed without printed bytes, while unauthorized destinations and alternate services fail.                         | Existing opt-in smoke plus concrete controlled negative probes; not run.                                                                                                                                                                               |
| FR-05 | Given intentionally closed ingress ports/protocols, when checking them, then proof distinguishes configured closure from unrelated target outage.                                                                                                | Inspect deployed service/IP configuration and verify allowed 443 control. Do not require an intentionally closed port to succeed outside the Sprite. Do not treat a UDP timeout alone as denial; receiver-side control or explicit denial is required. |
| FR-06 | Given an authenticated staging browser session, when a user starts a run, then a real Sprite is created under exact policy and the UI shows the correct URL; submission/reload remains consistent.                                               | Agent-browser against isolated staging data; no paid inference needed for start. Root retains an authenticated localhost browser. Isolated staging flow awaits infrastructure.                                                                         |
| FR-08 | Given missing or invalid endpoint configuration, when an authenticated player starts a run, then the UI/API returns an explicit unavailable/configuration message without provisioning or suggesting retry will fix it.                          | PASS: targeted regression failed before correction; full real Postgres/Pi/Sprite-boundary suite passed 201/201 in `worker-rollout-fr08-green-full.log`. Root confirmed the explicit message in the authenticated localhost browser.                    |
| FR-07 | Given completion or interruption, when cleanup runs, then test Sprites/controls/test DB resources and temporary DNS challenges are removed or explicitly inventoried, with no secret/body logs.                                                  | Resource ledger and scoped cleanup; not run.                                                                                                                                                                                                           |

## Steps and ownership

1. Lead: current account/DNS metadata, official capability/cost checks and this contract. Verify no changes to production resources.
2. Independent verifier: approve this rollout delta before configuration edits.
3. Runtime developer: minimal missing/invalid endpoint error translation at the existing provisioning boundary with a targeted regression. No fallback or fake URL.
4. Configuration developer: `deploy/flag-ingress/` Dockerfile, Fly config, Nginx template, entrypoint, restricted-role SQL and operational README. Use existing Node ingress, no new public application route or general proxy. Add focused local deployment checks under `scripts/` and `tests/` only where needed by the above acceptance criteria.
5. Lead: build/review configurations and run local tests. Prepare concrete DNS/certificate/disposable-database commands and retained-cost choice.
6. After required hosting decision: provision scoped staging resources, execute opt-in real Sprite checks and authenticated browser flow if access is available. Persist sanitized evidence and exact cleanup inventory.
7. Independent reviewer: full rollout delta and actual evidence. One bounded corrective cycle for this new rollout work. Existing feature findings remain resolved.

FR-05 correction ownership is explicit: the smoke developer owns `scripts/flag-ingress-smoke.ts`, `scripts/flag-ingress-smoke-contract.ts`, `tests/flag-ingress-smoke-contract.test.ts` and the contradictory outside-control guidance in `deploy/flag-ingress.md`. The implementation must distinguish reachable external controls from intentionally closed ingress services, pairing closed-service results with a healthy HTTPS control and deployed service/IP configuration. UDP proof requires explicit rejection or receiver-side observations with positive controls before and after; a timeout alone cannot pass.

## Executable browser validation

Root owns the user-authorized development server on localhost:3001 and the already authenticated `ctf-run-diagnosis` browser session. Do not close that browser, change its credentials, stop its server or rename its env file. Root owns all restarts and configuration handoff. The user explicitly requested actual new-run testing and handed over server control.

First prove infrastructure against the isolated Neon branch/test database. Then run a separate staging web process on an unused loopback port with a generated Better Auth secret, unique cookie prefix, that disposable DB and only the selected Sprite credential. Establish a synthetic member using real Better Auth APIs and an explicit fixture user, with a one-shot loopback bootstrap response carrying its genuine session cookie. No app auth decision is mocked and no test-only public route is added. Inspect actual start and reload there through a separate isolated browser session. This creates a real Sprite but needs no model inference.

The existing controlled `scripts/smoke.ts --messages-only` can prove the submission/review/seed-scoring lifecycle against the same disposable DB and real Sprites while intercepting only model service responses. Run it in its existing fresh-database mode before browser fixtures populate that database, or use a second empty disposable database. It is separate from browser start/reload proof. Authenticate and inspect the terminal run after this controlled lifecycle where practical. Do not claim a live model bypass or paid model evaluation.

Finally, making the user's existing localhost run work requires its ingress to connect to the same development database as that app. A validated staging sink cannot accept receipts for a different database. Preparing a restricted role/configuration for the user's development environment is a separate explicit handoff after isolated validation; do not point the public ingress at production or silently replace the user's database. Root will confirm this boundary with the user if current authorization does not cover it.

## Sources

- [Fly public networking](https://docs.fly.io/networking/services)
- [Fly raw passthrough explanation](https://community.fly.io/t/sni-based-routing-on-shared-ips-without-managed-certificates/27880)
- [Fly configuration](https://docs.fly.io/reference/configuration)
- [Fly pricing](https://fly.io/pricing/)
- [DNS-01](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge)
- [Nginx TLS rejection](https://nginx.org/en/docs/http/ngx_http_ssl_module.html#ssl_reject_handshake)
- [Nginx request limits](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html#limit_req_status)

## Checklist

- [x] Existing feature/worktree ownership preserved; account metadata inspected.
- [x] Running local server checkout and missing endpoint setting confirmed.
- [x] Revised plan independently verified by the independent gpt-6-astra/high verifier, including FR-08.
- [ ] Concrete deployable configuration and local evidence complete.
- [x] Retained 256 MB hosting choice recorded and independently approved. External DNS-01 certificate issuance remains to execute.
- [ ] Real deployment, Sprite policy/negative checks and browser flow proved.
- [ ] Resources and cleanup recorded; independent final review complete.

## Resource inventory

- Neon schema-only branch (ID omitted), name `staging/flag-http-submission`. Created with `init_source=parent-schema`, no parent data copied, 0.25 CU minimum/maximum and expiry `2026-11-16T00:00:00Z`. The free account rejected an explicit suspend interval before creating anything. The successful request uses its account-controlled setting.
- Empty database `ctf_smoke_flag_http` on that branch only. Application/auth schema initialization uses selected credentials from a private temporary file and synthetic other credentials.
- Fly app `ctf-flag-ingress-stage` created. Dedicated IPv4 (released) and IPv6 (released) allocated. No Machine was created.
- Vercel DNS records for `flags-stage.ctf.jonathanpollack.net`: A record (ID omitted) and AAAA record (ID omitted). Existing app DNS records remain unchanged.
- DNS-01 certificate issued. ACME state and private key are stored outside the repository under `/Users/jonathan/.config/ctf-flag-ingress`. Temporary DNS challenge cleaned by the issuer.
- The new Fly app has staged TLS and isolated staging database secrets. No existing app secrets changed.

## Current deployment hold

The independent predeployment review approved the correction and 256 MB trial. Actual `fly deploy` then failed before building or creating a Machine because Fly resolves the Dockerfile path relative to the configuration directory. The configured path was duplicated. This is a new deployment prerequisite finding after the bounded correction cycle. No automatic second source correction was made.

The user subsequently questioned the dedicated ingress architecture and proposed the existing Vercel backend. Root placed further deployment on hold while clarifying whether shared-host reachability is acceptable. Read-only investigation may continue. Do not broaden Sprite egress or mutate source/deployments before the revised boundary is agreed. Existing retained resources are inventoried above for reuse or scoped cleanup.
