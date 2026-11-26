import { journey, signIn } from "./browser";
import { newEmail, pool } from "./stack";

const signedOut = [
  ["/", "Capture the flag without getting caught"],
  ["/rules", "How to play"],
  ["/rank", "Leaderboard"],
  ["/contact", "Contact"],
  ["/signin", "Sign in"],
] as const;
const signedIn = [
  ["/play", /Upload the flag without getting caught/],
  ["/runs", "My runs"],
  ["/account", "Account"],
] as const;

journey("E5: signed-out pages load cleanly", async ({ page }) => {
  for (const [path, heading] of signedOut) {
    await page.goto(path);
    await page
      .getByRole("heading", { name: heading, level: path === "/" || path === "/contact" ? 1 : 2 })
      .waitFor();
    await page.waitForLoadState("networkidle");
  }
});

journey("E5: member pages load cleanly", async ({ page }) => {
  const email = newEmail("e5");
  await signIn(page, email, "/account");
  await pool().query(`UPDATE ctf."user" SET "displayName"=$2 WHERE email=$1`, [
    email,
    `e5_${email.slice(3, 11)}`,
  ]);
  for (const [path, heading] of signedIn) {
    await page.goto(path);
    await page.getByRole("heading", { name: heading }).first().waitFor();
    await page.waitForLoadState("networkidle");
  }
});
