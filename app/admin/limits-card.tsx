import { dollars, EFFORT_NAMES } from "@/app/run-format";
import { LIMITS, type LimitKey } from "@/lib/limits";
import type { Limits } from "@/lib/types";
import { SaveButton } from "./save-button";

const LABELS: Record<LimitKey, string> = {
  daily_cap_microdollars: "Shared daily cap",
  run_budget_microdollars: "Run budget",
  runs_per_day: "New runs per member per 24 hours",
  total_runs_per_day: "New runs for all players per 24 hours",
  monitor_run_allowance_microdollars: "Monitor allowance per run",
  final_review_allowance_microdollars: "Final review allowance per run",
  environments_open: "Environments open at once",
  name_checks_per_day: "Name checks per member per day",
  sessions_per_run: "Sessions per run",
  auto_continue_turns: "Auto-continue turns",
  agent_effort: "Attacker reasoning effort",
  investigator_effort: "Investigator reasoning effort",
};
const INVESTIGATOR_WARNING = "The leaderboard does not separate wins by investigator effort.";
const MICRODOLLARS_PER_DOLLAR = 1_000_000;
// Dollars with at most two decimals, the form the admin parser accepts.
const inDollars = (microdollars: number) =>
  String(Number((microdollars / MICRODOLLARS_PER_DOLLAR).toFixed(2)));

type Limit = (typeof LIMITS)[number];

function Field({ limit, limits, id }: { limit: Limit; limits: Limits; id: string }) {
  if (limit.kind === "choice")
    return (
      <select id={id} name="value" defaultValue={limits[limit.field]}>
        {limit.options.map((option) => (
          <option key={option} value={option}>
            {EFFORT_NAMES[option]}
          </option>
        ))}
      </select>
    );
  const money = limit.kind === "money";
  const unit = (value: number) => (money ? inDollars(value) : String(value));
  return (
    <input
      id={id}
      type="number"
      name="value"
      defaultValue={unit(limits[limit.field])}
      min={unit(limit.min)}
      max={unit(limit.max)}
      step={money ? "0.01" : "1"}
      required
    />
  );
}

const rangeHint = (limit: Limit) =>
  limit.kind === "choice"
    ? null
    : limit.kind === "money"
      ? `${dollars(limit.min)} to ${dollars(limit.max)}`
      : `${limit.min} to ${limit.max}`;

export function LimitsCard({
  action,
  limits,
  changedBy,
  refused,
}: {
  action: (formData: FormData) => void | Promise<void>;
  limits: Limits;
  changedBy: Partial<Record<LimitKey, string | null>>;
  refused: boolean;
}) {
  return (
    <section className="card">
      <header>
        <h3>Budgets and limits</h3>
        <span>Applies from the next request. A run keeps the budget it started with.</span>
      </header>
      {LIMITS.map((limit) => {
        const id = `limit-${limit.key}`;
        const hint = rangeHint(limit);
        return (
          <form key={limit.key} action={action} className="rule limit">
            <input type="hidden" name="key" value={limit.key} />
            <div>
              <label htmlFor={id}>{LABELS[limit.key]}</label>
              {hint && <small>{hint}</small>}
              {limit.key === "investigator_effort" && <small>{INVESTIGATOR_WARNING}</small>}
              {changedBy[limit.key] && <small>{changedBy[limit.key]}</small>}
            </div>
            <Field limit={limit} limits={limits} id={id} />
            <SaveButton />
          </form>
        );
      })}
      {refused && <p role="alert">That value was not saved. Enter a value the field allows.</p>}
    </section>
  );
}
