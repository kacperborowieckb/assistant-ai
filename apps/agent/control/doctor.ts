import { existsSync } from "node:fs";
import nodePath from "node:path";

import { Schema } from "effect";
import { unstable_getVarsForDev, unstable_readConfig } from "wrangler";

export interface Finding {
  readonly ok: boolean;
  readonly label: string;
}

export interface Diagnosis {
  readonly configuration: readonly Finding[];
  readonly secrets: readonly Finding[];
}

const personalAgentBinding = "PERSONAL_AGENT";
const personalAgentClass = "PersonalAgent";
const directoryBinding = "DIRECTORY";

const WranglerConfigSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  main: Schema.optional(Schema.String),
  compatibility_date: Schema.optional(Schema.String),
  durable_objects: Schema.Struct({
    bindings: Schema.Array(
      Schema.Struct({ name: Schema.String, class_name: Schema.String })
    ),
  }),
  migrations: Schema.Array(
    Schema.Struct({
      new_sqlite_classes: Schema.optional(Schema.Array(Schema.String)),
    })
  ),
  d1_databases: Schema.Array(
    Schema.Struct({
      binding: Schema.String,
      database_name: Schema.optional(Schema.String),
    })
  ),
  secrets: Schema.optional(
    Schema.Struct({ required: Schema.optional(Schema.Array(Schema.String)) })
  ),
});

type WranglerConfig = typeof WranglerConfigSchema.Type;

const readWranglerConfig = (configPath: string) =>
  Schema.decodeUnknownSync(WranglerConfigSchema)(
    unstable_readConfig({ config: configPath })
  );

const finding = (ok: boolean, label: string): Finding => ({ ok, label });

const checkEntry = (config: WranglerConfig, configPath: string) => {
  const configDirectory = nodePath.dirname(configPath);
  const entry =
    config.main === undefined
      ? undefined
      : nodePath.resolve(configDirectory, config.main);
  return finding(
    entry !== undefined && existsSync(entry),
    `Worker entry: ${entry === undefined ? "not set" : nodePath.relative(configDirectory, entry)}`
  );
};

const checkPersonalAgent = (config: WranglerConfig) => {
  const binding = config.durable_objects.bindings.find(
    (candidate) => candidate.name === personalAgentBinding
  );
  const usesSqlite = config.migrations.some((migration) =>
    migration.new_sqlite_classes?.includes(personalAgentClass)
  );
  return finding(
    binding?.class_name === personalAgentClass && usesSqlite,
    `Durable Object ${personalAgentBinding}: ${binding?.class_name ?? "not bound"}${usesSqlite ? " with SQLite storage" : " without a SQLite migration"}`
  );
};

const checkDirectory = (config: WranglerConfig) => {
  const database = config.d1_databases.find(
    (candidate) => candidate.binding === directoryBinding
  );
  return finding(
    database !== undefined,
    `D1 database ${directoryBinding}: ${database?.database_name ?? "not bound"}`
  );
};

const checkSecrets = (config: WranglerConfig, configPath: string) => {
  const required = config.secrets?.required ?? [];
  const available = new Set(
    Object.keys(
      unstable_getVarsForDev(configPath, undefined, {}, undefined, true, {
        required: [...required],
      })
    )
  );
  return required.map((name) =>
    finding(
      available.has(name),
      `${name} ${available.has(name) ? "is set" : "is missing"}`
    )
  );
};

export const diagnose = (configPath: string): Diagnosis => {
  const config = readWranglerConfig(configPath);
  return {
    configuration: [
      finding(
        config.name !== undefined,
        `Worker name: ${config.name ?? "not set"}`
      ),
      checkEntry(config, configPath),
      finding(
        config.compatibility_date !== undefined,
        `Compatibility date: ${config.compatibility_date ?? "not set"}`
      ),
      checkPersonalAgent(config),
      checkDirectory(config),
    ],
    secrets: checkSecrets(config, configPath),
  };
};

export const isHealthy = (diagnosis: Diagnosis) =>
  [...diagnosis.configuration, ...diagnosis.secrets].every(
    (candidate) => candidate.ok
  );

const renderFinding = (candidate: Finding) =>
  `  ${candidate.ok ? "ok     " : "problem"}  ${candidate.label}`;

export const renderDiagnosis = (diagnosis: Diagnosis) =>
  [
    "Configuration (wrangler.jsonc)",
    ...diagnosis.configuration.map(renderFinding),
    "Required secrets for local dev (.dev.vars, or .env and the shell environment)",
    ...diagnosis.secrets.map(renderFinding),
    isHealthy(diagnosis) ? "Result: healthy" : "Result: problems found",
  ].join("\n");
