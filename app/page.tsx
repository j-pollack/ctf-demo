import LandingContent from "@/app/landing-content";
import { pageSettings } from "@/app/page-settings";
import { flagEndpointUrl } from "@/lib/flag-submission-protocol";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { rules, limits } = await pageSettings();
  return <LandingContent submissionUrl={flagEndpointUrl()} rules={rules} limits={limits} />;
}
