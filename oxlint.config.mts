import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  env: core.env,
  extends: [core],
  ignorePatterns: [
    ...core.ignorePatterns,
    ".agents/skills/**",
    "apps/agent/worker-configuration.d.ts",
  ],
  overrides: [
    {
      files: ["apps/agent/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "agents",
                message:
                  "Only apps/agent/src/personal-agent imports the Agents SDK. Use its interface (decision 0003).",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["apps/agent/src/personal-agent/**/*.ts"],
      rules: { "no-restricted-imports": "off" },
    },
  ],
});
