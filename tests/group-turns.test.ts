import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTurns, liveCall, partialArgument, withDelta } from "../app/game-ui";
import type { GameEvent } from "../lib/types";

const agent = (id: number, command?: string): GameEvent => ({
  id,
  kind: "agent",
  text: "",
  turn: 1,
  command,
});
const monitor = (id: number, decision: "allow" | "block" | "error", command?: string, text = "") =>
  ({ id, kind: "monitor", decision, command, text }) as GameEvent;
const tool = (id: number, text: string): GameEvent => ({ id, kind: "tool", text });

test("groupTurns attaches each monitor review and its output to the preceding agent turn", () => {
  const groups = groupTurns([
    { id: 1, kind: "user", text: "go" },
    agent(2, "ls\npwd"),
    monitor(3, "allow", "ls"),
    tool(4, "a.txt"),
    monitor(5, "allow", "pwd"),
    tool(6, "/workspace"),
  ]);
  assert.deepEqual(
    groups.map((group) => group.event.id),
    [1, 2],
  );
  assert.deepEqual(groups[0].calls, []);
  assert.deepEqual(groups[1].calls, [
    { command: "ls", decision: "allow", reason: "", output: "a.txt" },
    { command: "pwd", decision: "allow", reason: "", output: "/workspace" },
  ]);
  assert.deepEqual(groups[1].pending, []);
});

test("a blocked call absorbs its Blocked tool result and keeps the monitor's reason", () => {
  const [group] = groupTurns([
    agent(1, "cat /tmp/flag.txt"),
    monitor(2, "block", "cat /tmp/flag.txt", "Reads the protected file."),
    tool(3, "Blocked"),
  ]);
  assert.deepEqual(group.calls, [
    {
      command: "cat /tmp/flag.txt",
      decision: "block",
      reason: "Reads the protected file.",
      output: undefined,
    },
  ]);
  assert.equal(groupTurns([agent(1, "x"), monitor(2, "block", "x"), tool(3, "Blocked")]).length, 1);
});

test("a monitor error absorbs its aborted result and the unrun rest stays visible", () => {
  const groups = groupTurns([
    agent(1, "a\nb\nc"),
    monitor(2, "allow", "a"),
    tool(3, "one"),
    monitor(4, "error", "b", "Inference unavailable"),
    tool(5, "Operation aborted"),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].calls.map(({ command, decision, reason, output }) => [
      command,
      decision,
      reason,
      output,
    ]),
    [
      ["a", "allow", "", "one"],
      ["b", "error", "Inference unavailable", undefined],
    ],
  );
  assert.deepEqual(groups[0].pending, ["c"]);
});

test("a tool result not directly after a monitor event stays standalone", () => {
  const groups = groupTurns([agent(1, "x"), tool(2, "Invalid command arguments")]);
  assert.deepEqual(
    groups.map((group) => group.event.kind),
    ["agent", "tool"],
  );
  assert.deepEqual(groups[0].calls, []);
  assert.deepEqual(groups[0].pending, ["x"]);
});

test("a monitor event without a command is tolerated", () => {
  const [group] = groupTurns([agent(1, "ls"), monitor(2, "allow"), tool(3, "out")]);
  assert.deepEqual(group.calls, [{ command: "", decision: "allow", reason: "", output: "out" }]);
  assert.deepEqual(group.pending, ["ls"]);
});

test("a partially reviewed turn shows the unreviewed remainder", () => {
  const [group] = groupTurns([agent(1, "a\nb"), monitor(2, "allow", "a"), tool(3, "out")]);
  assert.equal(group.calls.length, 1);
  assert.deepEqual(group.pending, ["b"]);
  // Reviewed prefix that is not a whole line never produces a remainder.
  const [partial] = groupTurns([agent(1, "ls -la"), monitor(2, "allow", "ls"), tool(3, "out")]);
  assert.deepEqual(partial.pending, []);
});

test("a call still awaiting output has none; zero calls fall back to the whole command", () => {
  const [running] = groupTurns([agent(1, "sleep 1"), monitor(2, "allow", "sleep 1")]);
  assert.equal(running.calls[0].output, undefined);
  assert.deepEqual(running.pending, []);
  const [bare] = groupTurns([agent(1, 'sprite_exec: {"command":"pwd"}')]);
  assert.deepEqual(bare.calls, []);
  assert.deepEqual(bare.pending, ["pwd"]);
  assert.deepEqual(groupTurns([agent(1)])[0].pending, []);
});

test("events outside an agent turn pass through unchanged", () => {
  const orphan = monitor(1, "block", "x", "No");
  const events: GameEvent[] = [
    orphan,
    tool(2, "Blocked"),
    { id: 3, kind: "error", text: "Stopped" },
  ];
  assert.deepEqual(
    groupTurns(events).map((group) => group.event),
    events,
  );
});

test("recorded commands stay one block per call, even when a command spans lines", () => {
  const heredoc = "cat <<EOF > a.txt\nhello\nEOF";
  const turn: GameEvent = {
    id: 1,
    kind: "agent",
    text: "",
    command: ["ls", heredoc, "pwd"].join("\n"),
    commands: ["ls", heredoc, "pwd"],
  };
  assert.deepEqual(groupTurns([turn])[0].pending, ["ls", heredoc, "pwd"]);
  const [reviewed] = groupTurns([turn, monitor(2, "allow", "ls"), tool(3, "a.txt")]);
  assert.deepEqual(reviewed.pending, [heredoc, "pwd"]);
});

test("streamed tool calls build up per call and show their command as it arrives", () => {
  let live = withDelta(null, { reasoning: "Plan", calls: [{ index: 0, name: "sprite_exec" }] });
  live = withDelta(live, { calls: [{ index: 0, arguments: '{"command": "echo \\"hi' }] });
  assert.equal(liveCall(live.calls[0]), 'echo "hi');
  live = withDelta(live, {
    calls: [
      { index: 0, arguments: '\\"\\nls"}' },
      { index: 1, name: "submit", arguments: '{"value":"flag{x' },
    ],
  });
  assert.deepEqual(live.calls.map(liveCall), ['echo "hi"\nls', "submit: flag{x"]);
  assert.equal(live.reasoning, "Plan");
  // Incomplete escapes wait for the rest instead of showing garbage.
  assert.equal(partialArgument('{"command":"a\\', "command"), "a");
  assert.equal(partialArgument('{"command":"\\u00e9\\u00', "command"), "é");
  assert.equal(partialArgument('{"comm', "command"), "");
});
