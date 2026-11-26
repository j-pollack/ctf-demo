"use client";
import { useLayoutEffect } from "react";

type Shell = { classList: { add(name: string): unknown; remove(name: string): unknown } };

// The CSS frames the app shell on the rules, rank and runs pages with :has(). A browser without
// :has() cannot see which page the shell holds, so mark the shell with a class it can match.
// Returns the cleanup, so leaving those pages restores the full-width shell for play.
export function markFramedShell(shell: Shell | null, supportsHas: boolean) {
  if (supportsHas || !shell) return () => {};
  shell.classList.add("framed");
  return () => shell.classList.remove("framed");
}

// A layout effect, so the shell changes before the first paint after hydration. Until then a
// browser without :has() shows the server-rendered full-width layout.
export function useFramedShell(framed: boolean) {
  useLayoutEffect(
    () =>
      markFramedShell(
        framed ? document.querySelector(".app") : null,
        CSS.supports("selector(:has(*))"),
      ),
    [framed],
  );
}
