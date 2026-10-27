import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool } from "pg";

export async function runHistoryTests(t: TestContext, pool: Pool) {
  await t.test("history is private and paginates persisted summaries", async (h) => {
    process.env.BETTER_AUTH_SECRET = "integration-only-secret-long-enough-for-better-auth";
    process.env.BETTER_AUTH_URL = "http://localhost";
    process.env.TRIPWIRE_COOKIE_PREFIX = "tripwire-integration";
    const { auth } = await import("../../lib/auth");
    const { getMigrations } = await import("better-auth/db/migration");
    await (await getMigrations(auth.options)).runMigrations();
    process.env.RESEND_API_KEY = "integration-only";
    process.env.RESEND_FROM = "Tripwire <test@example.invalid>";
    const email = `history-${randomUUID()}@example.invalid`;
    let magicLink = "";
    h.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, options?: RequestInit) => {
        assert.equal(String(input), "https://api.resend.com/emails", "Unexpected external request");
        const payload = JSON.parse(String(options?.body));
        assert.deepEqual(
          { from: payload.from, to: payload.to, subject: payload.subject },
          {
            from: process.env.RESEND_FROM,
            to: email,
            subject: "Your Capture the flag sign-in link",
          },
        );
        magicLink = payload.text.match(/http:\/\/localhost\S+/)?.[0] ?? "";
        assert.ok(magicLink);
        return Response.json({ id: "synthetic-resend-id" });
      },
    );
    const login = await auth.handler(
      new Request("http://localhost/api/auth/sign-in/anonymous", {
        method: "POST",
        headers: { origin: "http://localhost", "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    assert.ok(cookie);
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    assert.ok(session);
    const { GET } = await import("../../app/api/games/history/route");
    const request = (query = "") =>
      new Request(`http://localhost/api/games/history${query}`, { headers: { cookie } });
    const beforeAnonymousRequest = (await pool.query("SELECT count(*) FROM ctf.games")).rows[0]
      .count;
    assert.equal((await GET(new Request("http://localhost/api/games/history"))).status, 401);
    assert.equal(
      (await pool.query("SELECT count(*) FROM ctf.games")).rows[0].count,
      beforeAnonymousRequest,
    );
    const ids: string[] = Array.from({ length: 22 }, randomUUID);
    const difficulties = ["easy", "medium", "hard"];
    const difficultyOf = (id: string) => difficulties[ids.indexOf(id) % 3];
    for (let i = 0; i < ids.length; i++)
      await pool.query(
        `INSERT INTO ctf.games
      (id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,token_budget,status,monitor_difficulty,created_at,messages)
      VALUES($1,$2,$3,'never-select-this','agent','monitor','v1',100,$6,$7,$5,$4)`,
        [
          ids[i],
          session.user.id,
          `history-${ids[i]}`,
          JSON.stringify([{ secret: "must not list" }]),
          `2026-01-01 00:00:00.00000${i < 3 ? 3 : 1}+00`,
          ["active", "captured", "exhausted", "ended"][i % 4],
          difficulties[i % 3],
        ],
      );
    const foreignId = randomUUID();
    await pool.query(
      `INSERT INTO ctf.games(id,owner_id,sprite_name,secret_hash,agent_model,monitor_model,monitor_version,token_budget)
      VALUES($1,'other-owner',$2,'other-secret','agent','monitor','v1',100)`,
      [foreignId, `other-${foreignId}`],
    );
    const first = await GET(request("?limit=2"));
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const sorted = [...ids.slice(0, 3).sort().reverse(), ...ids.slice(3).sort().reverse()];
    assert.deepEqual(
      firstBody.runs.map((run: { id: string }) => run.id),
      sorted.slice(0, 2),
    );
    assert.ok(firstBody.nextCursor);
    assert.deepEqual(
      firstBody.runs.map((run: { monitorDifficulty: string }) => run.monitorDifficulty),
      sorted.slice(0, 2).map(difficultyOf),
    );
    assert.deepEqual(
      Object.keys(firstBody.runs[0]).sort(),
      [
        "agentModel",
        "blocks",
        "budgetMicrodollars",
        "createdAt",
        "id",
        "monitorDifficulty",
        "reservedMicrodollars",
        "spentMicrodollars",
        "status",
        "turns",
      ].sort(),
    );
    const next = await GET(request(`?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`));
    assert.deepEqual(
      (await next.json()).runs.map((run: { id: string }) => run.id),
      sorted.slice(2, 4),
    );
    assert.equal((await (await GET(request())).json()).runs.length, 20);
    assert.deepEqual(
      (await (await GET(request("?limit=50"))).json()).runs.map((run: { id: string }) => run.id),
      sorted,
    );
    assert.equal((await GET(request("?limit=51"))).status, 400);
    assert.equal((await GET(request("?limit=1&limit=2"))).status, 400);
    assert.equal((await GET(request("?cursor=bad"))).status, 400);
    assert.equal((await GET(request("?cursor="))).status, 400);
    assert.equal(
      (
        await GET(
          request(
            `?cursor=${Buffer.from(JSON.stringify({ createdAt: "2026-02-30T00:00:00.000001Z", id: ids[0] })).toString("base64url")}`,
          ),
        )
      ).status,
      400,
    );
    for (const createdAt of [
      "2026-01-01T25:00:00.000001Z",
      "2026-01-01T00:00:60.000001Z",
      "2026-02-30T00:00:00.000001Z",
    ]) {
      assert.equal(
        (
          await GET(
            request(
              `?cursor=${Buffer.from(JSON.stringify({ createdAt, id: ids[0] })).toString("base64url")}`,
            ),
          )
        ).status,
        400,
        `reject invalid cursor timestamp ${createdAt}`,
      );
    }
    assert.equal(
      (
        await GET(
          request(
            `?cursor=${Buffer.from(JSON.stringify({ createdAt: "2026-01-01T00:00:00.000001Z", id: "00000000000000000000000000000000" })).toString("base64url")}`,
          ),
        )
      ).status,
      400,
    );
    assert.equal((await GET(request(`?cursor=${"a".repeat(600)}`))).status, 400);
    const { GET: detail } = await import("../../app/api/games/[id]/route");
    await pool.query("INSERT INTO ctf.events(game_id,data) VALUES($1,$2)", [
      ids[0],
      JSON.stringify({ kind: "agent", text: "persisted transcript" }),
    ]);
    const ownDetail = await detail(request(), { params: Promise.resolve({ id: ids[0] }) });
    assert.equal(ownDetail.status, 200);
    const fullEvents = (await ownDetail.json()).events;
    assert.equal(fullEvents[0].text, "persisted transcript");
    await pool.query("INSERT INTO ctf.events(game_id,data) VALUES($1,$2)", [
      ids[0],
      JSON.stringify({ kind: "tool", text: "newer event" }),
    ]);
    const params = { params: Promise.resolve({ id: ids[0] }) };
    const delta = await (await detail(request(`?after=${fullEvents.at(-1).id}`), params)).json();
    assert.deepEqual(
      delta.events.map((event: { text: string }) => event.text),
      ["newer event"],
      "after cursor returns only newer events",
    );
    assert.equal(
      (await (await detail(request(`?after=${delta.events[0].id}`), params)).json()).events.length,
      0,
    );
    for (const bad of ["-1", "1.5", "abc", "9".repeat(16)])
      assert.equal(
        (await detail(request(`?after=${bad}`), params)).status,
        400,
        `reject event cursor ${bad}`,
      );
    assert.equal(
      (await detail(request(), { params: Promise.resolve({ id: randomUUID() }) })).status,
      404,
    );
    assert.equal(
      (await detail(request(), { params: Promise.resolve({ id: "not-a-run-id" }) })).status,
      404,
    );
    assert.equal(
      (
        await detail(new Request("http://localhost/api/games/history"), {
          params: Promise.resolve({ id: ids[0] }),
        })
      ).status,
      401,
    );
    assert.equal(
      (await detail(request(), { params: Promise.resolve({ id: foreignId }) })).status,
      404,
    );
    const { GET: latest } = await import("../../app/api/games/route");
    const latestResponse = await latest(request()),
      latestBody = await latestResponse.json();
    assert.ok(
      ids.includes(latestBody.game.id),
      "latest endpoint retains its one-game response contract",
    );

    const sendLink = async (sessionCookie: string) => {
      const sent = await auth.handler(
        new Request("http://localhost/api/auth/sign-in/magic-link", {
          method: "POST",
          headers: {
            origin: "http://localhost",
            cookie: sessionCookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email, callbackURL: "/" }),
        }),
      );
      assert.equal(sent.status, 200);
      assert.ok(magicLink);
      return auth.handler(new Request(magicLink, { headers: { cookie: sessionCookie } }));
    };
    const verified = await sendLink(cookie);
    assert.equal(verified.status, 302);
    const memberCookie = verified.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    assert.ok(memberCookie);
    const memberList = await GET(
      new Request("http://localhost/api/games/history?limit=50", {
        headers: { cookie: memberCookie },
      }),
    );
    assert.deepEqual(
      (await memberList.json()).runs.map((run: { id: string }) => run.id),
      sorted,
    );
    const secondSession = await sendLink("");
    assert.equal(secondSession.status, 302);
    const secondCookie = secondSession.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    assert.notEqual(secondCookie, memberCookie);
    const member = await auth.api.getSession({ headers: new Headers({ cookie: memberCookie }) });
    const freshMember = await auth.api.getSession({
      headers: new Headers({ cookie: secondCookie }),
    });
    assert.equal(freshMember?.user.id, member?.user.id);
    assert.deepEqual(
      (
        await (
          await GET(
            new Request("http://localhost/api/games/history?limit=50", {
              headers: { cookie: secondCookie },
            }),
          )
        ).json()
      ).runs.map((run: { id: string }) => run.id),
      sorted,
    );
    assert.equal((await pool.query("SELECT count(*) FROM ctf.games")).rows[0].count, "23");
  });
}
