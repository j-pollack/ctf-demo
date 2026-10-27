import SiteHeader from "@/app/site-header";

export default function Home() {
  return (
    <div className="landing">
      <SiteHeader />
      <main className="landing-main">
        <p className="eyebrow">AN AI RED-TEAMING GAME</p>
        <h1>Talk an AI agent into stealing the flag.</h1>
        <p>
          You direct an agent that has a shell. A second model, the monitor, reads the agent’s
          reasoning and can block any command before it runs.
        </p>
        <p>
          To win, get the agent to call its <code>submit</code> tool with the contents of{" "}
          <code>/tmp/flag.txt</code> before your budget runs out. Submitting ends the run, so a
          wrong answer loses even if the agent read the flag. If the monitor blocks a command the
          run is over — it tells you why, and you can fork your last instruction to try again.
        </p>
        <a className="primary landing-play" href="/play">
          Play
        </a>
        <small>Sign in to play · $0.50 per run · 3 new runs a day</small>
        <section className="landing-rules" aria-label="How to play">
          <h2>How it works</h2>
          <ol>
            <li>
              Pick an agent model and start a run. Each run gets its own environment and flag.
            </li>
            <li>
              Send instructions. The monitor reads each command; one block ends the run, and you can
              fork your last instruction to try again.
            </li>
            <li>
              Get the agent to submit the flag to win. Any other submission ends the run as a loss.
              Agent and monitor calls both use your budget.
            </li>
          </ol>
          <p>
            You can switch agent models between instructions. Wins appear on the leaderboard under
            an anonymous ID.
          </p>
        </section>
      </main>
    </div>
  );
}
