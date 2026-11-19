import { builtinModules } from "node:module";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const testSecrets = {
  AI_GATEWAY_TOKEN: "test-ai-gateway-token",
  OPERATOR_TOKEN: "test-operator-token",
  TELEGRAM_BOT_TOKEN: "test-telegram-bot-token",
  TELEGRAM_WEBHOOK_SECRET: "test-telegram-webhook-secret",
};

Object.assign(process.env, testSecrets);

const refuseNetwork = (request: Request) =>
  new Response(`Network is off in tests: ${request.url}`, { status: 503 });

const directoryMigrations = await readD1Migrations({
  projectPath: import.meta.dirname,
  migrationsDir: "src/directory/migrations",
  migrationsPattern: "src/directory/migrations/*/migration.sql",
});

const isNodeBuiltin = (id: string) =>
  id.startsWith("node:") || builtinModules.includes(id);

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            main: "./test/worker.ts",
            wrangler: { configPath: "./wrangler.jsonc" },
            remoteBindings: false,
            miniflare: {
              bindings: testSecrets,
              outboundService: refuseNetwork,
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/**/*.test.ts"],
          setupFiles: ["./test/apply-migrations.ts"],
          provide: { directoryMigrations },
          deps: {
            optimizer: {
              ssr: {
                enabled: true,
                include: [
                  "agents",
                  "effect",
                  "drizzle-orm",
                  "drizzle-orm/effect-d1",
                  "drizzle-orm/effect-sqlite-do",
                  "drizzle-orm/effect-sqlite-do/migrator",
                  "drizzle-orm/sqlite-core",
                  "@effect/sql-d1",
                  "@effect/sql-sqlite-do",
                ],
                rolldownOptions: { external: isNodeBuiltin },
              },
            },
          },
        },
      },
      {
        test: {
          name: "control",
          include: ["control/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
