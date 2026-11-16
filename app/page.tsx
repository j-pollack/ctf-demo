import LandingContent from "@/app/landing-content";
import { flagEndpointUrl } from "@/lib/flag-submission-protocol";

export const dynamic = "force-dynamic";

export default function Home() {
  return <LandingContent submissionUrl={flagEndpointUrl()} />;
}
