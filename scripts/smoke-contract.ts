export type SpriteProcessProbe = { ok: true; output: string } | { ok: false };

export function smokeReviewErrorCategory(value: string) {
  if (/reason|400.character|too.long/i.test(value)) return "decision-reason";
  if (/duplicate/i.test(value)) return "duplicate-citation";
  if (/excerpt|citation|evidence.*ref|reference/i.test(value)) return "citation";
  if (/finish_review/i.test(value)) return "finish-review";
  if (/retrieval|cursor|search/i.test(value)) return "retrieval";
  if (/deadline|timeout|timed out|aborted/i.test(value)) return "deadline-or-abort";
  if (/provider|openrouter|429/i.test(value)) return "provider";
  return "other";
}

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

export function successfulCommandStdout(output: string): string | undefined {
  const success = "\n[exit 0]";
  if (!output.endsWith(success)) return undefined;
  return output.slice(0, -success.length).split("\n[stderr]\n", 1)[0];
}

export function hasExactSuccessfulOutput(output: string, expected: string): boolean {
  return successfulCommandStdout(output) === expected;
}

export function assertRemoteProcessDeleted(
  probe: SpriteProcessProbe,
  deletionConfirmed: boolean,
): void {
  if (probe.ok) {
    if (hasExactSuccessfulOutput(probe.output, "process-running")) {
      throw new Error("The remote process is still running.");
    }
    if (hasExactSuccessfulOutput(probe.output, "process-stopped")) {
      throw new Error("The Sprite is still reachable after confirmed deletion.");
    }
    throw new Error("The process probe result is uncertain.");
  }
  if (!deletionConfirmed) {
    throw new Error("Sprite deletion is unconfirmed after the process probe failed.");
  }
}
