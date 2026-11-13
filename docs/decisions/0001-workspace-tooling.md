# 0001: Empty TypeScript monorepo foundation

Status: accepted

Date: 2026-11-13

## Decision

Use pnpm workspaces and Turborepo. Reserve `apps/*` for applications and services and `packages/*` for shared libraries and tooling. Keep both empty until application work starts. Define tasks when real package scripts exist.

Use Ultracite v8 with Oxlint core and Oxfmt. Keep type-aware checks and JavaScript plugins opt-in. Add framework presets only to the workspaces that use those frameworks. Use Lefthook for local checks and run the same `pnpm verify` command in GitHub CI.

Keep only skills that support current tooling or agreed upcoming work. The installed Turborepo, shadcn, and Ultracite skills support this plan. Remove setup or migration skills after their work is complete or when their source framework is absent.

## Why

The planned web, mobile, and backend applications need shared contracts and coordinated changes. A single workspace supports this while package boundaries keep runtime dependencies separate. Empty folders avoid premature framework and build choices.

Ultracite supplies consistent lint and format rules. Effect-specific checks need an Effect implementation and may require type-aware mode. There is no Effect code to check yet.

## Revisit if

A real app needs a framework preset, build pipeline, or shared package; Effect code needs additional diagnostics; or a runtime requires a toolchain that the workspace cannot support.
