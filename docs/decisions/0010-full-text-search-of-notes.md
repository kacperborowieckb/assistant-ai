# 0010: Full-text search of Notes

Status: accepted

Date: 2026-11-15

Supersedes the rule of [0007](0007-typed-queries-and-migrations.md) that no SQL string stays in a storage module, for the Note search only. Issue #33.

## Decision

- The Note search uses an SQLite FTS5 table, `notes_fts`, over the Note text and URL. A custom migration creates it, backfills it, and adds triggers on `notes` that keep it in step with insert, update, and delete in the same transaction.
- The table is declared as a typed Drizzle table in `src/notes/notes-fts.ts`. Drizzle Kit does not read this file, because it cannot create a virtual table.
- `Notes.search` runs typed queries against that table. The `MATCH` operator and `bm25()` are the only SQL fragments in a storage module, and each names the typed table. Every other rule of 0007 stays.
- The search turns the query into quoted words joined by `OR`, so a punctuation character in the question cannot break the `MATCH` expression.

## Reason

Drizzle has no FTS5 support. A typed table and two fragments keep the column names checked by `pnpm typecheck`, and they leave the ranking to SQLite.

## Revisit if

- Drizzle ORM adds FTS5 or virtual table support.
- Search needs a second ranking input, such as recency or links between Notes.
