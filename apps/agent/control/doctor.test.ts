import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import { diagnose, isHealthy, renderDiagnosis } from "./doctor.ts";
import { wranglerConfigPath } from "./workspace.ts";

const secretValues = {
  AI_GATEWAY_TOKEN: "value-of-ai-gateway-token-7f3a",
  TELEGRAM_BOT_TOKEN: "value-of-telegram-bot-token-91c2",
  TELEGRAM_WEBHOOK_SECRET: "value-of-telegram-webhook-secret-4e8d",
};

const instanceWith = ({
  config = readFileSync(wranglerConfigPath, "utf-8"),
  devVars,
}: {
  readonly config?: string;
  readonly devVars: Record<string, string>;
}) => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "agent-doctor-"));
  mkdirSync(nodePath.join(directory, "src"));
  writeFileSync(nodePath.join(directory, "src", "index.ts"), "");
  writeFileSync(nodePath.join(directory, "wrangler.jsonc"), config);
  writeFileSync(
    nodePath.join(directory, ".dev.vars"),
    Object.entries(devVars)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")
  );
  return nodePath.join(directory, "wrangler.jsonc");
};

describe("doctor", () => {
  it("reports a complete configuration as healthy without printing secret values", () => {
    const diagnosis = diagnose(instanceWith({ devVars: secretValues }));
    const report = renderDiagnosis(diagnosis);

    expect(isHealthy(diagnosis)).toBe(true);
    for (const [name, value] of Object.entries(secretValues)) {
      expect(report).toContain(`${name} is set`);
      expect(report).not.toContain(value);
    }
  });

  it("names each missing secret", () => {
    const diagnosis = diagnose(
      instanceWith({
        devVars: { TELEGRAM_BOT_TOKEN: secretValues.TELEGRAM_BOT_TOKEN },
      })
    );
    const report = renderDiagnosis(diagnosis);

    expect(isHealthy(diagnosis)).toBe(false);
    expect(report).toContain("TELEGRAM_BOT_TOKEN is set");
    expect(report).toContain("TELEGRAM_WEBHOOK_SECRET is missing");
    expect(report).toContain("AI_GATEWAY_TOKEN is missing");
    expect(report).not.toContain(secretValues.TELEGRAM_BOT_TOKEN);
  });

  it("reports a Personal Agent without SQLite storage as a problem", () => {
    const config = readFileSync(wranglerConfigPath, "utf-8").replace(
      '"new_sqlite_classes"',
      '"new_classes"'
    );
    const diagnosis = diagnose(instanceWith({ config, devVars: secretValues }));

    expect(isHealthy(diagnosis)).toBe(false);
    expect(renderDiagnosis(diagnosis)).toContain(
      "problem  Durable Object PERSONAL_AGENT: PersonalAgent without a SQLite migration"
    );
  });
});
