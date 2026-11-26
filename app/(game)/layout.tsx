import GameUI from "../game-ui";
import { MODELS } from "@/lib/policy";
import { flagEndpointUrl } from "@/lib/flag-submission-protocol";
import { currentGameRules } from "@/lib/game-rules";
import { currentLimits } from "@/lib/limits";

export const dynamic = "force-dynamic";
export default async function GameLayout({ children }: { children: React.ReactNode }) {
  const [rules, limits] = await Promise.all([currentGameRules(), currentLimits()]);
  return (
    <>
      <GameUI models={MODELS} submissionUrl={flagEndpointUrl()} rules={rules} limits={limits} />
      {children}
    </>
  );
}
