"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { changeAgentModel } from "@/lib/agent-model";
import { replyToFeedback, setFeedbackClosed } from "@/lib/feedback-mail";
import { changeGameRule } from "@/lib/game-rules-admin";
import { GameError } from "@/lib/policy";

// A GameError is a refusal the caller can see; anything else is a failure worth a log line.
function logUnexpected(event: string, error: unknown) {
  if (!(error instanceof GameError))
    console.error(
      JSON.stringify({ event, error: error instanceof Error ? error.message : String(error) }),
    );
}

// Every export of a "use server" file is a public endpoint, so each function checks the admin
// itself, inside the lib call.
export async function setAgentModel(formData: FormData) {
  let refused = false;
  try {
    await changeAgentModel(await headers(), formData.get("model"));
  } catch (error) {
    refused = true;
    logUnexpected("agent_model_change_failed", error);
  }
  if (refused) redirect("/admin?model=refused");
  revalidatePath("/admin");
  redirect("/admin");
}

export async function setGameRule(formData: FormData) {
  try {
    await changeGameRule(await headers(), formData.get("key"), formData.get("value"));
  } catch (error) {
    logUnexpected("game_rule_change_failed", error);
  }
  revalidatePath("/admin");
  redirect("/admin");
}

export async function replyFeedback(formData: FormData) {
  const path = `/admin/feedback/${encodeURIComponent(String(formData.get("id")))}`;
  let failed = false;
  try {
    await replyToFeedback(await headers(), String(formData.get("id")), formData.get("text"));
  } catch (error) {
    failed = true;
    logUnexpected("feedback_reply_failed", error);
  }
  if (failed) redirect(`${path}?error=reply`);
  revalidatePath(path);
  redirect(path);
}

export async function closeFeedback(formData: FormData) {
  const path = `/admin/feedback/${encodeURIComponent(String(formData.get("id")))}`;
  let failed = false;
  try {
    await setFeedbackClosed(
      await headers(),
      String(formData.get("id")),
      formData.get("closed") === "on",
    );
  } catch (error) {
    failed = true;
    logUnexpected("feedback_close_failed", error);
  }
  if (failed) redirect(`${path}?error=close`);
  revalidatePath(path);
  revalidatePath("/admin");
  redirect(path);
}
