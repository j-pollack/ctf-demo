import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { adminStats, isAdmin } from "@/lib/admin";
import { agentModelSetting, currentAgentModel } from "@/lib/agent-model";
import { MODELS } from "@/lib/policy";
import { setAgentModel } from "./actions";
import { AgentModelCard } from "./agent-model-card";
import {
  Area,
  Bars,
  Columns,
  DataTable,
  Legend,
  Sparkline,
  count,
  day,
  month,
  pct,
  usd,
} from "./charts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin — Capture the flag", robots: { index: false } };

const RUNS = "var(--series-1)",
  SPEND = "var(--series-2)",
  CONTEXT = "var(--context)";
const dollars = (micro: unknown) => Number(micro) / 1_000_000;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function Delta({ now, before }: { now: number; before: number }) {
  if (!before) return <small>no prior week</small>;
  const change = ((now - before) / before) * 100;
  return (
    <small>
      {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(0)}% vs prior 7 days
    </small>
  );
}

function Card({
  title,
  note,
  wide,
  children,
}: {
  title: string;
  note?: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={wide ? "card wide" : "card"}>
      <header>
        <h2>{title}</h2>
        {note && <span>{note}</span>}
      </header>
      {children}
    </section>
  );
}

async function requireAdmin() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!isAdmin(session?.user)) notFound();
}

const changedBy = (setting: Awaited<ReturnType<typeof agentModelSetting>>) =>
  setting &&
  `Changed by ${setting.updatedBy ?? "an admin"} · ${setting.updatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export default async function Admin({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireAdmin();
  const refused = (await searchParams).model === "refused";
  const [stats, setting, current] = await Promise.all([
    adminStats(),
    agentModelSetting(),
    currentAgentModel(),
  ]);
  const { totals: t, daily, monthly, outcomes, models, monitors, spenders } = stats;

  const days = daily.map((d) => day(d.day));
  const runs = daily.map((d) => Number(d.runs)),
    captures = daily.map((d) => Number(d.captures)),
    spend = daily.map((d) => dollars(d.spend));
  const week = (values: number[], offset = 0) =>
    sum(values.slice(-7 - offset, offset ? -offset : undefined));
  const months = [...monthly].reverse();

  return (
    <main className="admin">
      <header className="admin-head">
        <a href="/" className="wordmark">
          Capture the flag<span>_</span>
        </a>
        <span>Admin · all times UTC</span>
      </header>

      <section className="kpis" aria-label="Headline numbers">
        <div className="kpi">
          <span>Runs · 7 days</span>
          <strong>{count(week(runs))}</strong>
          <Delta now={week(runs)} before={week(runs, 7)} />
          <Sparkline values={runs} color={RUNS} />
          <small>{count(t.runs)} all time</small>
        </div>
        <div className="kpi">
          <span>Spend · 7 days</span>
          <strong>{usd(week(spend))}</strong>
          <Delta now={week(spend)} before={week(spend, 7)} />
          <Sparkline values={spend} color={SPEND} />
          <small>{usd(dollars(t.spend))} all time</small>
        </div>
        <div className="kpi">
          <span>Members</span>
          <strong>{count(t.members)}</strong>
          <small>{count(t.guests)} guests</small>
          <small>{count(t.players)} have played</small>
        </div>
        <div className="kpi">
          <span>Capture rate</span>
          <strong>{pct(t.captures, t.runs)}</strong>
          <small>
            {count(t.captures)} of {count(t.runs)} runs
          </small>
          <small>{usd(dollars(t.spend_per_capture))} per capture</small>
        </div>
        <div className="kpi">
          <span>Spend per run</span>
          <strong>{usd(dollars(t.spend_avg))}</strong>
          <small>
            median {usd(dollars(t.spend_p50))} · p90 {usd(dollars(t.spend_p90))}
          </small>
          <small>max {usd(dollars(t.spend_max))}</small>
        </div>
      </section>

      <dl className="health" aria-label="Operations">
        <div>
          <dt>Open runs</dt>
          <dd>{count(t.open_runs)}</dd>
        </div>
        <div>
          <dt>Held for billing</dt>
          <dd>{usd(dollars(t.reserved))}</dd>
        </div>
        <div>
          <dt>Turns per run</dt>
          <dd>{t.turns_avg.toFixed(1)}</dd>
        </div>
        <div>
          <dt>Catches per turn</dt>
          <dd>{pct(t.blocks, t.turns)}</dd>
        </div>
        <div>
          <dt>Estimated settlements</dt>
          <dd>{count(t.estimated_settlements)}</dd>
        </div>
      </dl>

      <div className="cards">
        <AgentModelCard
          action={setAgentModel}
          models={MODELS}
          current={current}
          changedBy={changedBy(setting)}
          refused={refused}
        />
        <Card title="Runs per day" note="Last 30 days">
          <Legend
            series={[
              { name: "Captured", color: RUNS },
              { name: "Other runs", color: CONTEXT },
            ]}
          />
          <Columns
            labels={days}
            values={daily.map((_, i) => [captures[i], runs[i] - captures[i]])}
            series={[
              { name: "Captured", color: RUNS },
              { name: "Other runs", color: CONTEXT },
            ]}
            format={(v) => count(v, true)}
            title={(i) =>
              `${days[i]}: ${runs[i]} runs, ${captures[i]} captured, ${daily[i].players} players`
            }
          />
          <DataTable
            head={["Day", "Runs", "Captured", "Players", "Spend"]}
            rows={daily.map((d, i) => [days[i], runs[i], captures[i], d.players, usd(spend[i])])}
          />
        </Card>

        <Card title="Spend per day" note={`${usd(sum(spend))} in 30 days`}>
          <Area
            labels={days}
            values={spend}
            color={SPEND}
            format={(v) => usd(v, true).replace(".00", "")}
            title={(i) => `${days[i]}: ${usd(spend[i])}`}
          />
          <DataTable head={["Day", "Spend"]} rows={days.map((d, i) => [d, usd(spend[i])])} />
        </Card>

        <Card title="Signups per month" note="Last 12 months">
          <Legend
            series={[
              { name: "Members", color: RUNS },
              { name: "Guests", color: CONTEXT },
            ]}
          />
          <Columns
            labels={months.map((m) => month(m.month))}
            values={months.map((m) => [Number(m.members), Number(m.guests)])}
            series={[
              { name: "Members", color: RUNS },
              { name: "Guests", color: CONTEXT },
            ]}
            format={(v) => count(v, true)}
            title={(i) =>
              `${month(months[i].month)}: ${months[i].members} members, ${months[i].guests} guests`
            }
          />
          <DataTable
            head={["Month", "Members", "Guests"]}
            rows={months.map((m) => [month(m.month), m.members, m.guests])}
          />
        </Card>

        <Card title="Run outcomes" note="All time">
          <Bars
            color={RUNS}
            rows={outcomes.map((o) => ({
              label: o.status,
              sub: `${usd(dollars(o.spend) / Number(o.runs))} per run`,
              value: Number(o.runs),
              display: `${count(o.runs)} · ${pct(Number(o.runs), t.runs)}`,
            }))}
          />
        </Card>

        <Card title="Spend by model" note="Settled inference">
          <Bars
            color={SPEND}
            rows={models.map((m) => ({
              label: m.model,
              sub: `${m.role} · ${count(Number(m.calls), true)} calls · ${count(Number(m.tokens), true)} tokens${Number(m.pending) ? ` · ${m.pending} pending` : ""}`,
              value: dollars(m.spend),
              display: usd(dollars(m.spend)),
            }))}
          />
        </Card>

        <Card
          title="Capture rate by monitor"
          note="By classifier model and recorded difficulty. New runs all record hard."
        >
          <Bars
            color={RUNS}
            rows={monitors.map((s) => ({
              label: `${s.monitor_model} · ${s.monitor_difficulty}`,
              sub: `${count(s.runs)} runs · ${usd(dollars(s.spend))}`,
              value: Number(s.runs) ? Number(s.captures) / Number(s.runs) : 0,
              display: pct(Number(s.captures), Number(s.runs)),
            }))}
          />
        </Card>

        <Card title="Top spenders" note="All time" wide>
          <Bars
            color={SPEND}
            rows={spenders.map((s) => ({
              label: s.guest || !s.who ? "Guest" : s.who,
              sub: `${count(s.runs)} runs · ${count(s.captures)} captured`,
              value: dollars(s.spend),
              display: usd(dollars(s.spend)),
            }))}
          />
        </Card>
      </div>
    </main>
  );
}
