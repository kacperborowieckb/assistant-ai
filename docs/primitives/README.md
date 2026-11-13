# Primitives catalog

A primitive is a building block that hides useful behavior behind a small interface. Record implemented primitives in [catalog.json](catalog.json). The catalog is empty because the workspace has no product implementation.

For each primitive, record `id`, `purpose`, `roots`, and `adrs`. Use a unique stable ID, a short purpose, existing repository-relative code paths, and the paths of current accepted decision records that shape the primitive. Use `adrs: []` when no record applies.

Every workspace with a `package.json` must be covered by at least one primitive's roots. A root can name the workspace itself or an implementation path within it. Split entries when the code has distinct interfaces worth finding separately. Do not create a package for each entry.

The agent that adds or reshapes a primitive updates the catalog in the same change. When it adds or supersedes a decision record, it updates affected `adrs` lists. Remove entries when their implementation is removed.

`pnpm verify` checks required fields, duplicate IDs, existing paths, current decision links, and workspace coverage. It cannot judge whether a purpose describes the code correctly. Agents must check that during implementation and review.

The [architecture](../product/architecture.md) defines Channel, Event, Schedule, Document, Skill, and Journal, and [CONTEXT.md](../../CONTEXT.md) defines their terms. These are planned concepts, not catalog entries or implemented interfaces. Add entries when their implementations exist.
