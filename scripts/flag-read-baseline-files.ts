import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Independently enumerate the runtime, seeder, migrations and installed dependency lock.
// Never trust the list of paths supplied by a schedule, and never read environment files.
export function baselineSources(root = process.cwd()): Record<string, string> {
  const paths = ["package.json", "package-lock.json", "tsconfig.json"];
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(ts|sql)$/.test(entry.name)) paths.push(path);
    }
  };
  for (const directory of ["lib", "scripts", "db"]) visit(directory);
  return Object.fromEntries(
    paths.sort().map((path) => [path, readFileSync(join(root, path), "utf8")]),
  );
}
