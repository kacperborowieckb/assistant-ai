# 0007: Typed queries and migrations

Status: accepted

Date: 2026-11-14

Closes issues #20 and #21. The Owner chose Drizzle ORM on issue #20.

## Decision

Use Drizzle ORM with its native Effect drivers for both stores of `apps/agent`: the Directory in D1 (`drizzle-orm/effect-d1` over `@effect/sql-d1`) and each Personal Agent SQLite (`drizzle-orm/effect-sqlite-do` over `@effect/sql-sqlite-do`). Use Drizzle Kit to generate the migrations. Both come from the `rc` tag (1.0.0 release candidate), which is the only version with Effect v4 drivers.

- One table schema file for each store is the single source of truth: `src/directory/directory-schema.ts` and `src/personal-agent/storage-schema.ts`. Queries use these tables, so a wrong column name fails `pnpm typecheck`.
- A query is an Effect. A database failure is a typed error (`EffectDrizzleQueryError` or `SqlError`) in the Effect error channel, not a thrown defect.
- Module interfaces do not change, except that their Effects can now fail with these errors. No module outside `directory` runs queries against the Directory ([0006](0006-directory-store.md)).
- No SQL string stays in a storage module. SQL lives only in migration files. The one exception is the `CHECK` constraints in the table schema files. They build their SQL from the same value lists as the column types (`src/check-values.ts`), so the lists exist once.
- Run `pnpm --filter @repo/agent migrations:generate` after a schema change, and commit the new migration folders. A change that Drizzle Kit cannot express (a trigger, seed data) goes in a custom migration (`drizzle-kit generate --custom`).
- Directory migrations are in `src/directory/migrations/<timestamp>_<name>/migration.sql`. `wrangler.jsonc` sets `migrations_pattern` to this layout, and setup applies them with `wrangler d1 migrations apply`.
- Personal Agent migrations are in `src/personal-agent/migrations`. Each Personal Agent applies the pending ones in order when it builds its storage layer, in one transaction. It records each applied migration in `__drizzle_migrations`. A migration that fails rolls back, the storage layer fails with `MigrationFailed`, and the Personal Agent runs no Turn on that schema.
- The Journal triggers that refuse UPDATE and DELETE are a custom migration.

## Why

A typed schema moves column and row-shape errors from run time to type check. Every later slice adds tables, so the gain grows. Drizzle supports D1 and Durable Object SQLite with one schema style, and it generates migrations, which closes the migration question of #21 with the same tool. The native Effect drivers fit the Effect services of [0003](0003-runtime-and-model-stack.md): no `Effect.sync` wrapper and typed errors.

Rejected: Kysely. It types queries but has no migration generator that fits a Durable Object. Rejected: plain SQL with stricter tests. It keeps the run-time failure mode. Rejected: the stable Drizzle 0.45 with the Promise drivers. It needs `Effect.sync` wrappers that turn database errors into defects, and Drizzle moves to the 1.0 layout anyway.

## Costs and limits

- The Worker bundle grew by about 370 KiB (see [the verification guide](../verification/agent.md)).
- The D1 Effect driver does not support transactions. The Directory writes an Owner and its Channel Identity as one `D1Client.batch`, built from the typed queries with `toSQL()`.
- The D1 client takes a `D1Database`. The Directory passes a D1 session through a cast, because the client uses only `prepare` and `batch`, which the session has.
- The Effect drivers have no documentation page for D1 or Durable Objects yet. Their behavior is checked by the tests.
- The 1.0 release candidate can still change before release.

## Revisit if

- Drizzle ORM 1.0 changes the Effect drivers or the migrator before release.
- Bundle size or startup CPU becomes a problem on the live Worker.
