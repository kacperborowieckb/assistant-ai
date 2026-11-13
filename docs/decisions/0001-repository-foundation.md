# 0001: Repository foundation

Status: accepted

Date: 2026-11-13

## Decision

### Tooling

Use pnpm workspaces and Turborepo. Use Ultracite v8 with Oxlint core and Oxfmt. Keep type-aware checks and JavaScript plugins opt-in. Add framework presets only to the workspaces that use those frameworks. Use Lefthook for local checks, and run the same `pnpm verify` command in GitHub CI.

Keep only skills that support current tooling or agreed upcoming work. Remove setup or migration skills after their work is complete or when their source framework is absent. The Turborepo and Ultracite skills support this plan. The shadcn skill does not, because there is no web app for Owners (see [0004](0004-owners-and-channels.md)). Remove it, and add it back only when the marketing site starts and uses it.

### Workspace layout

This layout is a direction, not a fixed or complete plan. Follow it by default. When real work shows a better shape, change the layout and update this record in the same change.

- `apps/` holds deployable units. Each app has its own deploy config.
- `packages/` holds code that at least two workspaces need. Do not create a package for one consumer.
- `plugins/` holds parts that a fork can add or remove, such as Channels. The agent works with any subset of them.
- The agent core stays in `apps/agent`, because only the agent runs it. There is no `packages/core`.
- Code that only the hosted product needs goes in `apps/platform`. Self-hosters never deploy it.

```
apps/
  agent/              Cloudflare Worker: Edge, Directory, Personal Agent, Evals       MVP
  mobile/             Native app: chat main screen and settings                       Mobile phase
  site/               Static marketing site and self-host docs                        Before public launch
  platform/           Hosted only: accounts, billing, Registration, managed keys      Hosted phase
packages/
  create-assistant/   One-command installer: resources, config, secrets               MVP
  contracts/          Shared schemas: mobile Channel protocol, Owner ids, platform API Mobile phase
  plugin-sdk/         Channel and Skill interfaces for plugins                        Second Channel
  tsconfig/           Shared TypeScript config                                        Second TypeScript app
plugins/
  channel-telegram/   Moved out of apps/agent                                         Second Channel
  channel-email/                                                                      Email Channel
  channel-mobile/     WebSocket adapter for apps/mobile                               Mobile phase
```

Keep `apps/` and `packages/` empty until application work starts. Create each workspace only at its stage. In the MVP, Telegram is a module inside `apps/agent`. Inside `apps/agent`, use one module for each domain area, for example `edge`, `directory`, `personal-agent`, `channels/telegram`, `memory`, `journal`, `schedule`, `proactivity`, `behavior`, `model-gateway`, `tracing`, and `evals`.

When the first plugin is created, add `plugins/*` to `pnpm-workspace.yaml` and to the workspace scan in `tools/verify-foundation.mjs`.

### Verification and Turborepo tasks

Define Turborepo tasks when real package scripts exist. In the change that adds `apps/agent`:

- Each workspace defines its own checks (for example `check`, `typecheck`, `test`) and a `verify` script. The root runs them through `turbo run verify`, not `pnpm --recursive`.
- The root keeps only checks that cover the whole repository, such as the format check and the foundation check.
- CI runs only affected workspaces (`--affected`) and uses a remote cache. Local hooks use the local cache.
- Evals call real models, cost money, and are not deterministic. They stay out of `verify` and run as a separate task that the owner or an agent starts.

### Catalog and verification records

Maintain a [primitives catalog](../primitives/README.md) and a [workspace verification registry](../verification/README.md). When a workspace is added, require catalog coverage, current decision links, a verification guide, and a local `verify` script. Run structural checks and workspace scripts from the root verification command and the Git hooks.

The implementing agent updates these records in the same change as the code. Add real control commands with the first runnable application and a generated Feature Map when routes exist. Until then, empty registries are correct. No background maintenance agent is configured.

## Why

The planned agent, mobile, site, and platform applications need shared contracts and coordinated changes. One repository keeps a contract change and its consumers in one change, gives one toolchain and one verification command, and gives agents the whole system in one checkout. Package boundaries keep runtime dependencies separate. Empty folders avoid early framework and build choices.

Comparable open-source personal agents use the same shape. Talorys has `apps/agent`, a shared package, an installer package, and a site. Vellum separates its gateway, its assistant core, its clients, and its contract packages. GAIA has mobile and bot apps. OpenClaw, Hermes Agent, and elizaOS keep each Channel as a plugin after they support many Channels. A package with one consumer is a shallow seam whose interface is still a guess. A module with a clean interface inside `apps/agent` can move to a package or plugin later with little work.

Turborepo saves CI minutes and local time when there are several workspaces and most changes touch only one area. GitHub Actions minutes are limited for this repository, so the savings matter.

Ultracite supplies consistent lint and format rules. Effect-specific checks need an Effect implementation and may require type-aware mode.

Future agents need a reliable map of the implementation and a way to prove their work. Structural checks catch missing records without invented product primitives or runtime proof. Code review still must check semantic accuracy and behavior coverage.

## Revisit if

- A real app needs a framework preset, build pipeline, or shared package, or a runtime needs a toolchain that the workspace cannot support.
- Effect code needs more diagnostics.
- A stage arrives and its workspace does not fit the layout rules, a second consumer needs a module from `apps/agent`, or plugins need a different loading model.
- Turborepo caching gives no measurable savings.
- The first runtime needs more proof commands, a framework supplies a route generator, or repeated failures show that manual semantic review needs a stronger automated check.
