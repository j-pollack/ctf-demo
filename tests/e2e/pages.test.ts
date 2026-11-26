import { journey, signIn } from "./browser";
import { newEmail, pool } from "./stack";

journey("E5: signed-out pages load cleanly", async ({ page }) => {
  const settle = () => page.waitForLoadState("networkidle");
  await page.goto("/");
  await page.getByTestId("page-home").waitFor();
  await settle();
  await page.goto("/rules");
  await page.getByTestId("page-rules").waitFor();
  await settle();
  await page.goto("/rank");
  await page.getByTestId("page-rank").waitFor();
  await settle();
  await page.goto("/contact");
  await page.getByTestId("page-contact").waitFor();
  await settle();
  await page.goto("/signin");
  await page.getByTestId("page-signin").waitFor();
  await settle();
});

journey("E5: member pages load cleanly", async ({ page }) => {
  const settle = () => page.waitForLoadState("networkidle");
  const email = newEmail("e5");
  await signIn(page, email, "/account");
  await pool().query(`UPDATE ctf."user" SET "displayName"=$2 WHERE email=$1`, [
    email,
    `e5_${email.slice(3, 11)}`,
  ]);
  await page.goto("/play");
  await page.getByTestId("page-play").waitFor();
  // The page root is in the server HTML. This block waits for the session and the run state.
  await page.getByTestId("play-no-run").waitFor();
  await settle();
  await page.goto("/runs");
  await page.getByTestId("page-history").waitFor();
  await settle();
  await page.goto("/account");
  await page.getByTestId("page-account").waitFor();
  await settle();
});
