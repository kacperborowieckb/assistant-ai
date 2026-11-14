# 0007: Typed queries and migrations

Status: accepted

Date: 2026-11-14

Closes issues #20 and #21. The Owner chose Drizzle ORM on issue #20.

## Decision

Use Drizzle ORM for both stores of `apps/agent`: the Directory in D1 (`drizzle-orm/d1`) and each Personal Agent SQLite (`drizzle-orm/durable-sqlite`). Use Drizzle Kit to generate the migrations.

- One table schema file for each store is the single source of truth: `src/directory/directory-schema.ts` and `src/personal-agent/storage-schema.ts`. Queries use these tables, so a wrong column name fails `pnpm typecheck`.
- Module interfaces do not change. No module outside `directory` runs queries against the Directory ([0006](0006-directory-store.md)).
- No SQL string stays in a storage module. SQL lives only in migration files.
- Run `pnpm --filter @repo/agent migrations:generate` after a schema change, and commit the new migration files. A change that Drizzle Kit cannot express (a trigger, seed data) goes in a custom migration (`drizzle-kit generate --custom`).
- Directory migrations are in `src/directory/migrations`. Setup applies them with `wrangler d1 migrations apply`.
- Personal Agent migrations are in `src/personal-agent/migrations`. Each Personal Agent applies the pending ones in order when it builds its storage layer, in one transaction. It records each applied migration in `__drizzle_migrations`. A migration that fails rolls back, the storage layer fails with `MigrationFailed`, and the Personal Agent runs no Turn on that schema.
- The Journal triggers that refuse UPDATE and DELETE are a custom migration.

## Why

A typed schema moves column and row-shape errors from run time to type check. Every later slice adds tables, so the gain grows. Drizzle supports D1 and Durable Object SQLite with one schema style, and it generates migrations, which closes the migration question of #21 with the same tool.

Rejected: Kysely. It types queries but has no migration generator that fits a Durable Object. Rejected: plain SQL with stricter tests. It keeps the run-time failure mode.

## Costs and limits

- The Worker bundle grew by about 190 KiB (see [the verification guide](../verification/agent.md)).
- The Durable Object migrator compares only the newest recorded migration time, so migrations must have rising times. Drizzle Kit makes them so.
- `drizzle()` takes a `D1Database`. The Directory passes a D1 session through a cast, because Drizzle uses only `prepare` and `batch`, which the session has.

## Revisit if

- Drizzle ORM v1 changes the Durable Object migrator or the D1 session handling.
- Bundle size or startup CPU becomes a problem on the live Worker.
