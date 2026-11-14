export function scrollRunToBottom(thread: HTMLElement | null) {
  // Instant: smooth scrolling can stall short of the latest output.
  thread?.scrollTo({ top: thread.scrollHeight, behavior: "instant" });
}

export function runScrollPosition(
  element: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">,
  previous?: { top: number; atBottom: boolean },
) {
  const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
  return {
    top: element.scrollTop,
    atBottom: nearBottom || !!(previous?.atBottom && element.scrollTop >= previous.top),
  };
}
