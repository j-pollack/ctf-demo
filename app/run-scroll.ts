// Run details moves scrolling from the transcript to its enclosing console while open.
export function runScrollContainer(thread: HTMLElement | null): HTMLElement | null {
  const console = thread?.closest<HTMLElement>(".console");
  return console?.querySelector(".stakes-detail[open]") ? console : thread;
}

export function scrollRunToBottom(thread: HTMLElement | null) {
  const element = runScrollContainer(thread);
  // Instant: smooth scrolling can stall short of the latest output.
  element?.scrollTo({ top: element.scrollHeight, behavior: "instant" });
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
