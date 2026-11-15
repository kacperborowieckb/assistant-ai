import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import { createTestHarness, experimental_readRawConfig } from "wrangler";

import { agentRoot, wranglerConfigPath } from "./workspace.ts";

export interface LocalWorkerSecrets {
  readonly TELEGRAM_BOT_TOKEN: string;
  readonly TELEGRAM_WEBHOOK_SECRET: string;
  readonly AI_GATEWAY_TOKEN: string;
  readonly OPERATOR_TOKEN: string;
}

export const temporarySecrets = (): LocalWorkerSecrets => ({
  TELEGRAM_BOT_TOKEN: `local-${randomUUID()}`,
  TELEGRAM_WEBHOOK_SECRET: randomUUID(),
  AI_GATEWAY_TOKEN: `local-${randomUUID()}`,
  OPERATOR_TOKEN: randomUUID(),
});

export interface LocalWorkerOptions {
  readonly main?: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly secrets: LocalWorkerSecrets;
}

const configOf = ({ main, vars, secrets }: LocalWorkerOptions) => {
  const { rawConfig } = experimental_readRawConfig({
    config: wranglerConfigPath,
  });
  const { secrets: _requiredSecrets, ...config } = rawConfig;
  return {
    ...config,
    ...(main === undefined ? {} : { main }),
    vars: { ...config.vars, ...vars, ...secrets },
  };
};

export const startLocalWorker = (options: LocalWorkerOptions) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const harness = createTestHarness({
        root: agentRoot,
        workers: [{ config: configOf(options) }],
      });
      const { url } = await harness.listen();
      await harness.getWorker().applyD1Migrations("DIRECTORY");
      return { harness, url };
    }),
    ({ harness }) => Effect.promise(() => harness.close())
  ).pipe(Effect.map(({ url }) => url));
