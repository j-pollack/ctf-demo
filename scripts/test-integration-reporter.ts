import { realpathSync } from "node:fs";
import { Readable } from "node:stream";
import { spec } from "node:test/reporters";
import type { TestEvent } from "node:test/reporters";

// The code under test logs every inference call and every handled failure. Hold each file's
// process output and print it only once a test in that file fails. The runner does not order
// output against test results, so output cannot be attributed to one test within a file.
export async function* heldOutput(
  source: Iterable<TestEvent> | AsyncIterable<TestEvent>,
): AsyncGenerator<TestEvent> {
  const held = new Map<string, TestEvent[]>();
  const failed = new Set<string>();
  for await (const event of source) {
    const isOutput = event.type === "test:stdout" || event.type === "test:stderr";
    if (!isOutput && event.type !== "test:fail") {
      yield event;
      continue;
    }
    // Output events name the file as it was passed to the runner; results name its real path.
    const file = event.data.file && realpathSync(event.data.file);
    if (isOutput && file && !failed.has(file)) {
      held.set(file, [...(held.get(file) ?? []), event]);
      continue;
    }
    if (file && !failed.has(file)) {
      failed.add(file);
      yield* held.get(file) ?? [];
      held.delete(file);
    }
    yield event;
  }
}

export default async function* reporter(source: AsyncIterable<TestEvent>) {
  yield* Readable.from(heldOutput(source)).pipe(new spec());
}
