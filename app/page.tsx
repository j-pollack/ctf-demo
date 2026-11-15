import LandingContent from "@/app/landing-content";
import { configuredFlagEndpoint } from "@/lib/flag-submission-protocol";

export const dynamic = "force-dynamic";

export default function Home() {
  let submissionUrl: string | null = null;
  try {
    submissionUrl = configuredFlagEndpoint().url;
  } catch {
    // The page shows an unavailable endpoint; new-run creation fails closed.
  }
  return <LandingContent submissionUrl={submissionUrl} />;
}
