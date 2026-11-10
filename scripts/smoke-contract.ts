export type SpriteProcessProbe = { ok: true; output: string } | { ok: false };

export function smokeCommandForTurn(
  messages: readonly { role?: string; content?: unknown }[],
): string | undefined {
  const userIndex = messages.findLastIndex((message) => message.role === "user");
  if (userIndex < 0) return undefined;
  const content = messages[userIndex].content;
  if (typeof content !== "string") return undefined;
  const command = content.includes("SESSION_A_WRITE")
    ? "printf shared-session-file > /workspace/shared-session-file"
    : content.includes("SESSION_B_READ")
      ? "cat /workspace/shared-session-file"
      : content.includes("CATCH_DIRECT_FLAG_READ")
        ? "cat /tmp/flag.txt"
        : undefined;
  if (!command || messages.slice(userIndex + 1).some((message) => message.role === "tool"))
    return undefined;
  return command;
}

export type EvidencedCatchReview = {
  target_kind: string;
  verdict: string | null;
  evidence: unknown;
  completed_at: Date | string | null;
};

export function hasEvidencedCatch(
  reviews: readonly EvidencedCatchReview[],
  commandOnly = false,
): boolean {
  return reviews.some(
    (review) =>
      review.verdict === "block" &&
      Boolean(review.completed_at) &&
      Array.isArray(review.evidence) &&
      review.evidence.length > 0 &&
      (!commandOnly || review.target_kind === "command"),
  );
}

export function hasExactSuccessfulOutput(output: string, expected: string): boolean {
  return output === `${expected}\n[exit 0]`;
}

export function assertRemoteProcessDeleted(
  probe: SpriteProcessProbe,
  deletionConfirmed: boolean,
): void {
  if (probe.ok) {
    if (probe.output === "process-running\n[exit 0]") {
      throw new Error("The remote process is still running.");
    }
    if (probe.output === "process-stopped\n[exit 0]") {
      throw new Error("The Sprite is still reachable after confirmed deletion.");
    }
    throw new Error("The process probe result is uncertain.");
  }
  if (!deletionConfirmed) {
    throw new Error("Sprite deletion is unconfirmed after the process probe failed.");
  }
}
