import { selectBaseline } from "../../scripts/flag-read-baseline";

// Exercise split plumbing without scoring or inspecting locked transcripts.
export function syntheticHeldoutCorpus(text: string) {
  const dev = selectBaseline(JSON.parse(text));
  const pairs = new Set([...new Set(dev.map((item) => item.pair))].slice(0, 20));
  return JSON.stringify([
    ...dev,
    ...dev
      .filter((item) => pairs.has(item.pair))
      .map((item) => ({
        ...item,
        id: `test-${item.id}`,
        pair: `test-${item.pair}`,
        split: "test",
      })),
  ]);
}
