import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    ".agents/skills/**",
    "apps/agent/worker-configuration.d.ts",
    "packages/tokens/tokens.css",
    "packages/tokens/theme.json",
  ],
});
