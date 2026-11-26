"use client";
import { useLayoutEffect } from "react";

type Shell = { classList: { add(name: string): unknown; remove(name: string): unknown } };

// The CSS frames the app shell with :has() whenever it holds a `main.info` page, which is every
// page but the run console. A browser without :has() cannot see that, so mark the shell with a
// class it can match. Returns the cleanup, so going to the console restores the full width.
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
