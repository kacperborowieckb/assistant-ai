import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { Context, Effect, Layer } from "effect";

import { MigrationFailed } from "./migration-failed.ts";
import personalAgentMigrations from "./migrations/migrations.js";

export type AgentMigrations = Parameters<typeof migrate>[1];

export const makeAgentDatabase = (storage: DurableObjectStorage) =>
  drizzle(storage);

export type AgentDatabase = ReturnType<typeof makeAgentDatabase>;

export class AgentStorage extends Context.Service<
  AgentStorage,
  { readonly database: AgentDatabase }
>()("PersonalAgent/AgentStorage") {
  static readonly layer = (
    storage: DurableObjectStorage,
    migrations: AgentMigrations = personalAgentMigrations
  ) =>
    Layer.effect(
      AgentStorage,
      Effect.gen(function* migrateStorage() {
        const database = makeAgentDatabase(storage);
        yield* Effect.tryPromise({
          try: () => migrate(database, migrations),
          catch: (cause) => new MigrationFailed({ cause }),
        });
        return { database };
      })
    );
}
