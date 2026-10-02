import GameUI from "../game-ui";
import { AGENT_MODEL, MODELS } from "@/lib/policy";
import { currentSeason } from "@/lib/seasons";

export const dynamic = "force-dynamic";
export default async function Play() {
  return (
    <GameUI models={MODELS} defaultAgent={AGENT_MODEL} initialSeason={await currentSeason()} />
  );
}
