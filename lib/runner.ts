import type { GameRow } from "./games";
import { runAsyncGame } from "./runner-async";

export function runGame(
  game: GameRow,
  prompt: string,
  signal: AbortSignal,
  send: (type: string, data: unknown) => void,
  options: {
    deadlineSignal?: AbortSignal;
    beforePrompt?: (signal: AbortSignal) => Promise<void>;
  } = {},
) {
  return runAsyncGame(game, prompt, signal, send, options);
}
export { repairMessages } from "./transcript-repair";
