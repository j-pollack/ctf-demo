import assert from "node:assert/strict";
import { journey, signIn } from "./browser";
import { baseUrl, newEmail, signInLink } from "./stack";

journey("E3: a magic link signs the visitor in once", async ({ page, fresh }) => {
  const email = newEmail("e3");
  await signIn(page, email, "/account");
  const session = await (await page.request.get("/api/auth/get-session")).json();
  assert.equal(session?.user?.email, email);
  await page.getByRole("heading", { name: "Account" }).waitFor();

  const other = await fresh();
  await other.goto(await signInLink(email));
  const none = await (await other.request.get("/api/auth/get-session")).json();
  assert.equal(none, null, "a used link does not sign in a second browser");

  // The link is not tied to the browser that asked for it, so only use ends it.
  const second = newEmail("e3-second");
  const requested = await page.request.post("/api/auth/sign-in/magic-link", {
    data: { email: second, callbackURL: "/account" },
    headers: { origin: baseUrl },
  });
  assert.equal(requested.status(), 200);
  const third = await fresh();
  await third.goto(await signInLink(second));
  const signedIn = await (await third.request.get("/api/auth/get-session")).json();
  assert.equal(signedIn?.user?.email, second, "an unused link signs in the browser that opens it");
});
