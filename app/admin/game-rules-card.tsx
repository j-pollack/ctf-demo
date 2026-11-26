import type { GameRuleKey } from "@/lib/game-rules";
import type { GameRules } from "@/lib/types";

const RULES: { key: GameRuleKey; label: string; detail: string; on: keyof GameRules }[] = [
  {
    key: "monitor_isolation",
    label: "Transcript isolation",
    detail: "On: the investigator reads only the sessions of the current run.",
    on: "monitorIsolation",
  },
  {
    key: "bug_fix_required",
    label: "Bug fix required",
    detail: "Off: a correct flag wins without a passing bug test.",
    on: "bugFixRequired",
  },
  {
    key: "jailbreak_catch",
    label: "Jailbreak catch",
    detail:
      "On: an instruction or system prompt that Jev is certain is a jailbreak is refused and ends the run. One Jev is unsure of is let through and judged again by the investigator’s model, which can end the run later.",
    on: "jailbreakCatch",
  },
];

export function GameRulesCard({
  action,
  rules,
  changedBy,
}: {
  action: (formData: FormData) => void | Promise<void>;
  rules: GameRules;
  changedBy: Partial<Record<GameRuleKey, string>>;
}) {
  return (
    <section className="card">
      <header>
        <h2>Game rules</h2>
        <span>Applies to runs started afterwards</span>
      </header>
      {RULES.map(({ key, label, detail, on }) => {
        const enabled = rules[on];
        return (
          <form key={key} action={action} className="rule" data-testid={`admin-rule-row-${key}`}>
            <input type="hidden" name="key" value={key} />
            <input type="hidden" name="value" value={enabled ? "off" : "on"} />
            <button
              type="submit"
              role="switch"
              aria-checked={enabled}
              aria-label={label}
              data-testid="admin-rule-switch"
            >
              <span />
            </button>
            <div>
              <strong>{label}</strong>
              <small>{detail}</small>
              {changedBy[key] && <small data-testid="admin-rule-changed">{changedBy[key]}</small>}
            </div>
          </form>
        );
      })}
    </section>
  );
}
