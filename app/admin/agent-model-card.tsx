import { SaveButton } from "./save-button";

export function AgentModelCard({
  action,
  models,
  current,
  changedBy,
  refused,
}: {
  action: (formData: FormData) => void | Promise<void>;
  models: string[];
  current: string;
  changedBy: string | null;
  refused: boolean;
}) {
  return (
    <section className="card">
      <header>
        <h2>Attacker model</h2>
        <span>Applies to every player&rsquo;s next instruction</span>
      </header>
      <form action={action}>
        <label htmlFor="agent-model">Model</label>{" "}
        <select id="agent-model" name="model" defaultValue={current}>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>{" "}
        <SaveButton />
      </form>
      {changedBy && <small>{changedBy}</small>}
      {refused && (
        <p role="alert">
          That model was not saved. It must be on the allowlist and served by the catalog.
        </p>
      )}
    </section>
  );
}
