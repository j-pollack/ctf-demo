import GameUI from "../game-ui";
import { MODELS } from "@/lib/policy";
import { configuredFlagEndpoint } from "@/lib/flag-submission-protocol";

export const dynamic = "force-dynamic";
export default async function GameLayout({ children }: { children: React.ReactNode }) {
  let submissionUrl: string | null = null;
  try {
    submissionUrl = configuredFlagEndpoint().url;
  } catch {
    // The UI shows an unavailable endpoint; new-run creation fails closed on the server.
  }
  return (
    <>
      <GameUI models={MODELS} submissionUrl={submissionUrl} />
      {children}
    </>
  );
}
