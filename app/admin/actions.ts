"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { changeAgentModel } from "@/lib/agent-model";
import { GameError } from "@/lib/policy";

// The only export: every export of a "use server" file is a public endpoint.
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
