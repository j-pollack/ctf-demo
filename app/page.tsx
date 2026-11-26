import LandingContent from "@/app/landing-content";
import { flagEndpointUrl } from "@/lib/flag-submission-protocol";
import { currentGameRules } from "@/lib/game-rules";
import { currentLimits } from "@/lib/limits";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [rules, limits] = await Promise.all([currentGameRules(), currentLimits()]);
  return <LandingContent submissionUrl={flagEndpointUrl()} rules={rules} limits={limits} />;
}
