import type { GameRow } from "./games";
import { runGame as runLegacyGame } from "./runner-session";
import { runAsyncGame } from "./runner-async";

export function runGame(
  game: GameRow,
  prompt: string,
  signal: AbortSignal,
  send: (type: string, data: unknown) => void,
  options: { deadlineSignal?: AbortSignal } = {},
) {
  return game.monitor_mode === "async"
    ? runAsyncGame(game, prompt, signal, send, options)
    : runLegacyGame(game, prompt, signal, send, options);
}
export { repairMessages } from "./transcript-repair";
