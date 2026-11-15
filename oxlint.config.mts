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
  rules: {
    "max-params": ["error", { max: 3 }],
  },
  overrides: [
    {
      files: ["apps/**/src/**/*.ts", "apps/**/control/**/*.ts"],
      excludeFiles: ["**/*.test.ts"],
      rules: {
        "max-lines": [
          "error",
          { max: 250, skipBlankLines: true, skipComments: true },
        ],
      },
    },
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
