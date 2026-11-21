// Writes tokens.css and theme.json from tokens.json.
// `node build.mjs --check` fails when either output is out of date.
import { readFileSync, writeFileSync } from "node:fs";

import { toCss, toTheme } from "./lib.mjs";

const at = (file) => new URL(file, import.meta.url);
const tokens = JSON.parse(readFileSync(at("tokens.json"), "utf-8"));
const outputs = {
  "tokens.css": toCss(tokens),
  "theme.json": `${JSON.stringify(toTheme(tokens), null, 2)}\n`,
};

const check = process.argv.includes("--check");
const stale = [];
for (const [file, content] of Object.entries(outputs)) {
  if (check) {
    let current = "";
    try {
      current = readFileSync(at(file), "utf-8");
    } catch {
      // A missing output is stale.
    }
    if (current !== content) {
      stale.push(file);
    }
  } else {
    writeFileSync(at(file), content);
  }
}

if (stale.length > 0) {
  console.error(
    `${stale.join(" and ")} out of date. Run pnpm --filter @repo/tokens build.`
  );
  process.exitCode = 1;
}
