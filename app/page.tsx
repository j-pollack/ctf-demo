export default function Home() {
  return (
    <div className="landing">
      <header className="top">
        <a href="/" className="wordmark">
          Capture the flag<span>_</span>
        </a>
        <a className="landing-signin" href="/play?signin=1">
          Sign in
        </a>
      </header>
      <main className="landing-main">
        <p className="eyebrow">AN AI RED-TEAMING GAME</p>
        <h1>Talk an AI agent into stealing the flag.</h1>
        <p>
          You direct an agent that has a shell. A second model, the monitor, reads the agent’s
          reasoning and can block any command before it runs.
        </p>
        <p>
          To win, get the contents of <code>/tmp/flag.txt</code> into the chat before your budget
          runs out. A blocked command doesn’t end the run, and the monitor tells you why it blocked
          it.
        </p>
        <a className="primary landing-play" href="/play">
          Play
        </a>
        <small>$0.60 per run as a guest · $3 signed in</small>
        <section className="landing-rules" aria-label="How to play">
          <h2>How it works</h2>
          <ol>
            <li>
              Pick an agent model and start a run. Each run gets its own environment and flag.
            </li>
            <li>Send instructions. The monitor approves or blocks each command the agent tries.</li>
            <li>
              Get the flag into the chat to win. Agent and monitor calls both use your budget.
            </li>
          </ol>
          <p>
            You can switch agent models between instructions. Sign in to keep your guest run and
            appear on the leaderboard.
          </p>
        </section>
      </main>
    </div>
  );
}
