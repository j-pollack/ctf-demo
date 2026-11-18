import LandingContent from "@/app/landing-content";
import { flagEndpointUrl } from "@/lib/flag-submission-protocol";
import { currentGameRules } from "@/lib/game-rules";

export const dynamic = "force-dynamic";

export default async function Home() {
  return <LandingContent submissionUrl={flagEndpointUrl()} rules={await currentGameRules()} />;
}
