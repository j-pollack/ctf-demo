import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "tests/e2e";

// The source of every file under tests/e2e/, keyed by path.
export function e2eSources() {
  return readdirSync(DIR)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file: join(DIR, file), source: readFileSync(join(DIR, file), "utf8") }));
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");

// Blanks comments, and the inside of string literals, with spaces. Line numbers and the quote
// marks stay, so a scan sees code only. With `keepStrings` the string contents stay.
export function stripSource(source: string, keepStrings = false) {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === "\\") {
        const pair = char + (source[i + 1] ?? "");
        out += keepStrings ? pair : blank(pair);
        i++;
      } else if (char === quote) {
        out += char;
        quote = null;
      } else out += keepStrings ? char : blank(char);
    } else if (char === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      const line = source[i + 1] === "/";
      const end = source.indexOf(line ? "\n" : "*/", i + 2);
      const stop = end === -1 ? source.length : line ? end : end + 2;
      out += blank(source.slice(i, stop));
      i = stop - 1;
    } else {
      if (char === '"' || char === "'" || char === "`") quote = char;
      out += char;
    }
  }
  return out;
}
