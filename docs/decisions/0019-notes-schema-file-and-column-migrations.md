# 0019: Notes tables in their own schema file, and a column migration for notes

Status: accepted

Date: 2026-11-18

Issue #98, part of #97. Supersedes two parts of [0007](0007-typed-queries-and-migrations.md): the rule of one table schema file for each store, and the rule that every migration comes from `drizzle-kit generate`. All other parts of 0007 stay.

## Decision

- **Schema files.** `src/personal-agent/storage-schema.ts` stays the one module that code and `drizzle.personal-agent.config.ts` import for the Personal Agent tables. The `notes` and `note_links` tables and their value lists live in `src/personal-agent/notes-schema.ts`, and `storage-schema.ts` re-exports them. Reason: the lint limit of 250 lines applies to the schema file, and the notes tables are one cohesive group.
- **Notes migrations add columns.** A change to `notes` uses `ALTER TABLE ... ADD COLUMN` in a custom migration, with each check on a new column named and written as in the schema and the snapshot. It never rebuilds the table. Reason: `DROP TABLE notes` cascade-deletes the rows of `note_links` (the Durable Object keeps foreign keys on, and `PRAGMA foreign_keys=OFF` has no effect inside a migration transaction) and drops the full-text triggers. The Open Loop migration test proves that links, search, and triggers survive.

## Review

Review this when a change needs a table rebuild of `notes` (for example a new `NOT NULL` column without a default), or when another store passes the line limit.
