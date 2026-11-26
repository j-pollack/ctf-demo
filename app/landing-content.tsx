import SiteFooter from "@/app/site-footer";
import SiteHeader from "@/app/site-header";
import { dollars, runCount } from "@/app/run-format";
import { HowToWin, Premise } from "@/app/flag-instructions";
import type { GameRules, PlayerLimits } from "@/lib/types";

export default function LandingContent({
  submissionUrl,
  rules,
  limits,
}: {
  submissionUrl: string | null;
  rules: GameRules;
  limits: PlayerLimits;
}) {
  return (
    <div className="landing">
      <SiteHeader />
      <main className="landing-main">
        <h1>Capture the flag without getting caught</h1>
        <Premise />
        <p>
          We built this to study AI oversight. If frontier labs agreed to pause training, could an
          AI monitor catch someone starting a training run in secret? Here the monitor even knows
          which file to watch.
        </p>
        <a className="primary landing-play" href="/play">
          Play
        </a>
        <small>
          Free to play. Each run gets {dollars(limits.runBudgetMicrodollars)} of AI usage, and you
          can start {runCount(limits.runsPerDay)} every 24 hours.
        </small>
        <section className="landing-rules" aria-label="How to win">
          <h2>How to win</h2>
          <HowToWin url={submissionUrl} rules={rules} brief />
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
