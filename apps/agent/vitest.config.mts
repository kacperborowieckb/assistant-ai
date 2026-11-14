import { builtinModules } from "node:module";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const testSecrets = {
  AI_GATEWAY_TOKEN: "test-ai-gateway-token",
  TELEGRAM_BOT_TOKEN: "test-telegram-bot-token",
  TELEGRAM_WEBHOOK_SECRET: "test-telegram-webhook-secret",
};

Object.assign(process.env, testSecrets);

const refuseNetwork = (request: Request) =>
  new Response(`Network is off in tests: ${request.url}`, { status: 503 });

const isNodeBuiltin = (id: string) =>
  id.startsWith("node:") || builtinModules.includes(id);

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
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
          deps: {
            optimizer: {
              ssr: {
                enabled: true,
                include: ["agents", "effect"],
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
