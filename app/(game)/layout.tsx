import GameUI from "../game-ui";
import { pageSettings } from "@/app/page-settings";
import { MODELS } from "@/lib/policy";
import { flagEndpointUrl } from "@/lib/flag-submission-protocol";

export const dynamic = "force-dynamic";
export default async function GameLayout({ children }: { children: React.ReactNode }) {
  const { rules, limits } = await pageSettings();
  return (
    <>
      <GameUI models={MODELS} submissionUrl={flagEndpointUrl()} rules={rules} limits={limits} />
      {children}
    </>
  );
}
