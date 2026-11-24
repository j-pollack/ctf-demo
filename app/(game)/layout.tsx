import GameUI from "../game-ui";
import { MODELS } from "@/lib/policy";
import { flagEndpointUrl } from "@/lib/flag-submission-protocol";
import { currentGameRules } from "@/lib/game-rules";

export const dynamic = "force-dynamic";
export default async function GameLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <GameUI models={MODELS} submissionUrl={flagEndpointUrl()} rules={await currentGameRules()} />
      {children}
    </>
  );
}
