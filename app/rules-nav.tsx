"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Section = readonly [id: string, title: string];

// A heading this far from the top of the window marks its section as the one being read.
const READING_LINE = 160;

// The section being read is the last one whose heading has scrolled up past the reading line.
// At the end of the page the last section counts, since a short one may never reach the line.
export function currentSection(tops: readonly number[], line: number, atEnd: boolean) {
  if (atEnd) return tops.length - 1;
  const passed = tops.findLastIndex((top) => top <= line);
  return Math.max(passed, 0);
}

type Shell = { classList: { add(name: string): unknown; remove(name: string): unknown } };

// The CSS releases the app shell to document scrolling with :has(). A browser without :has()
// cannot see that the shell holds the rules page, so mark the shell with a class it can match.
// Returns the cleanup, so leaving the rules page restores the shell for the other panels.
export function markReadingShell(shell: Shell | null, supportsHas: boolean) {
  if (supportsHas || !shell) return () => {};
  shell.classList.add("reading");
  return () => shell.classList.remove("reading");
}

// The rules page's list of sections. It marks the section in view, so a reader always knows
// where they are in a long page.
export function RulesNav({ sections }: { sections: readonly Section[] }) {
  const [current, setCurrent] = useState<string | null>(null);
  const nav = useRef<HTMLElement>(null);
  // A layout effect, so the shell changes before the first paint after hydration. Until then a
  // browser without :has() shows the server-rendered panel layout.
  useLayoutEffect(
    () => markReadingShell(nav.current?.closest(".app") ?? null, CSS.supports("selector(:has(*))")),
    [],
  );
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const tops = sections.map(
        ([id]) => document.getElementById(id)?.getBoundingClientRect().top ?? Infinity,
      );
      const page = document.documentElement;
      const atEnd =
        window.scrollY > 0 && window.scrollY + window.innerHeight >= page.scrollHeight - 2;
      setCurrent(sections[currentSection(tops, READING_LINE, atEnd)][0]);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [sections]);
  return (
    <nav ref={nav} className="rules-nav" aria-labelledby="rules-nav-label">
      <p id="rules-nav-label">On this page</p>
      <ul>
        {sections.map(([id, title]) => (
          <li key={id}>
            <a href={`#${id}`} aria-current={id === current ? "location" : undefined}>
              {title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
