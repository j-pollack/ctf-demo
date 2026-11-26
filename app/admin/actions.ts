"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { changeAgentModel } from "@/lib/agent-model";
import { changeGameRule } from "@/lib/game-rules-admin";
import { changeLimit } from "@/lib/limits-admin";
import { GameError } from "@/lib/policy";

// Every export of a "use server" file is a public endpoint, so each function checks the admin
// itself, inside the lib call.
export async function setAgentModel(formData: FormData) {
  let refused = false;
  try {
    await changeAgentModel(await headers(), formData.get("model"));
  } catch (error) {
    refused = true;
    if (!(error instanceof GameError))
      console.error(
        JSON.stringify({
          event: "agent_model_change_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }
  if (refused) redirect("/admin?model=refused");
  revalidatePath("/admin");
  redirect("/admin");
}

export async function setGameRule(formData: FormData) {
  try {
    await changeGameRule(await headers(), formData.get("key"), formData.get("value"));
  } catch (error) {
    if (!(error instanceof GameError))
      console.error(
        JSON.stringify({
          event: "game_rule_change_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }
  revalidatePath("/admin");
  redirect("/admin");
}

export async function setLimit(formData: FormData) {
  let refused = false;
  try {
    await changeLimit(await headers(), formData.get("key"), formData.get("value"));
  } catch (error) {
    refused = true;
    if (!(error instanceof GameError))
      console.error(
        JSON.stringify({
          event: "limit_change_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }
  if (refused) redirect("/admin?limit=refused");
  revalidatePath("/admin");
  redirect("/admin");
}
