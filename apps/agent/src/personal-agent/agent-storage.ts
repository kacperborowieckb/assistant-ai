import { SqliteClient } from "@effect/sql-sqlite-do";
import { makeWithDefaults } from "drizzle-orm/effect-sqlite-do";
import type { EffectSQLiteDoDatabase } from "drizzle-orm/effect-sqlite-do";
import { migrate } from "drizzle-orm/effect-sqlite-do/migrator";
import { Context, Effect, Layer } from "effect";

import { MigrationFailed } from "./migration-failed.ts";
import personalAgentMigrations from "./migrations/migrations.js";

export type AgentMigrations = Parameters<typeof migrate>[1];

export class AgentStorage extends Context.Service<
  AgentStorage,
  { readonly database: EffectSQLiteDoDatabase }
>()("PersonalAgent/AgentStorage") {
  static readonly layer = (
    storage: DurableObjectStorage,
    migrations: AgentMigrations = personalAgentMigrations
  ) =>
    Layer.effect(
      AgentStorage,
      Effect.gen(function* migrateStorage() {
        const database = yield* makeWithDefaults({});
        yield* migrate(database, migrations).pipe(
          Effect.mapError((cause) => new MigrationFailed({ cause }))
        );
        return { database };
      })
    ).pipe(Layer.provide(SqliteClient.layer({ storage })));
}
