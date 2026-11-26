import { dollars } from "@/app/run-format";
import { LIMITS, type LimitKey } from "@/lib/limits";
import type { Limits } from "@/lib/types";

const LABELS: Record<LimitKey, string> = {
  daily_cap_microdollars: "Shared daily cap",
  run_budget_microdollars: "Run budget",
  runs_per_day: "New runs per member per 24 hours",
  total_runs_per_day: "New runs for all players per 24 hours",
  monitor_run_allowance_microdollars: "Monitor allowance per run",
  final_review_allowance_microdollars: "Final review allowance per run",
};
const MICRODOLLARS_PER_DOLLAR = 1_000_000;
// Dollars with at most two decimals, the form the admin parser accepts.
const inDollars = (microdollars: number) =>
  String(Number((microdollars / MICRODOLLARS_PER_DOLLAR).toFixed(2)));

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
        <h2>Budgets and limits</h2>
        <span>Applies from the next request. A run keeps the budget it started with.</span>
      </header>
      {LIMITS.map((limit) => {
        const money = limit.kind === "money";
        const unit = (value: number) => (money ? inDollars(value) : String(value));
        const id = `limit-${limit.key}`;
        return (
          <form key={limit.key} action={action} className="rule limit">
            <input type="hidden" name="key" value={limit.key} />
            <div>
              <label htmlFor={id}>{LABELS[limit.key]}</label>
              <small>
                {money
                  ? `${dollars(limit.min)} to ${dollars(limit.max)}`
                  : `${limit.min} to ${limit.max}`}
              </small>
              {changedBy[limit.key] && <small>{changedBy[limit.key]}</small>}
            </div>
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
            <button type="submit">Save</button>
          </form>
        );
      })}
      {refused && (
        <p role="alert">
          That value was not saved. Enter a number inside the range shown for that field.
        </p>
      )}
    </section>
  );
}
