# Architecture

Terms follow [CONTEXT.md](../../CONTEXT.md). This document shows the target shape. The MVP builds only the parts marked MVP.

## Request flow

```
Owner (Telegram)
   |  webhook
   v
Edge (Worker)  -- verifies the Channel request
   |  Channel Identity -> Directory -> Owner Id
   v
Personal Agent (Durable Object, one per Owner)
   |  Event -> Inbox -> router (dedupe, merge bursts, Owner first)
   |  Turn: Profile + state + Notes -> Model Gateway -> tools
   |  every step -> Journal; every Turn -> Trace; tokens -> Usage
   v
Channel send action -> Telegram message to the Owner
```

A fired Schedule enters the same Inbox as an Event. Proactive work and Owner messages use the same Turn loop.

## Components

| Component | Responsibility | Stage |
| --- | --- | --- |
| Edge | Receives Channel webhooks, verifies them, resolves the Owner, forwards Events. Holds no Owner data. | MVP |
| Directory | Maps Channel Identities to Owner Ids, Owner status, and Registration state. | MVP |
| Personal Agent | One Durable Object per Owner: Inbox, Turn loop, Notes, Profile, Journal, Schedules, Owner Preferences. | MVP |
| Telegram Channel | Receive and send for Telegram. Acknowledge, texting style, and confirmed delivery status. | MVP |
| Memory | Notes, links, keyword search, Profile, and Forget with Tombstones. | MVP |
| Journal | Append-only log. The agent reads it and cannot edit it. | MVP |
| Schedule | Reminders, the Brief, and self-set wake-ups through Durable Object alarms. | MVP |
| Proactivity | Decides if the Owner needs to know. Applies Quiet Hours, Budgets, merging, and Outcomes. | MVP |
| Behavior | Typed Behavior Config and Owner Preferences. | MVP |
| Model Gateway | Provider choice, model per task, Model Credentials per Owner, Usage. | MVP |
| Tracing | A replayable Trace for every Turn. | MVP |
| Evals | Eval cases for full Turn sequences, run as pass^k. | MVP |
| Helpers | Durable workflows for long work. | Later |
| Approval | Pending actions, Owner approval in the Channel, Auto-review. | Later |
| Integrations | MCP client and OAuth tokens per Owner. | Later |
| Mobile Channel | WebSocket protocol between `apps/mobile` and the Personal Agent. | Later |
| Platform | Accounts, billing, open Registration, managed Model Credentials. | Later |

## Tenancy

Multi-owner by design, single-owner by configuration. See [decision 0004](../decisions/0004-owners-and-channels.md).

- The Personal Agent for an Owner is `idFromName(ownerId)`. Its SQLite database holds only that Owner's data.
- Any other storage is keyed by Owner Id: the R2 prefix `owners/{ownerId}/`, one Vectorize namespace for each Owner, and the Owner Id in every Workflow and Queue payload.
- No code reads a global "current Owner". The Edge resolves the Owner once and passes it in.
- Forget-me for an Owner: clear the Personal Agent storage, delete the R2 prefix, and remove the Directory entry.

## Technology split

See [decision 0003](../decisions/0003-runtime-and-model-stack.md).

- **Cloudflare Workers + Agents SDK:** the runtime, Durable Objects, alarms, and later Workflows, R2, and Vectorize.
- **Vercel AI SDK:** the model loop, tool calls, and streaming. The only model layer.
- **Effect:** services, config, typed errors, retries, timeouts, Channel adapters, tool implementations, and schemas. One runtime for each Durable Object.
- The Agents SDK sits behind our own interfaces, because it changes fast.

## Extension seams

A fork extends the agent through these interfaces, each one an Effect Layer:

- **Channel:** receive and send.
- **Skill:** tools, prompts, and an optional Schedule.
- **Behavior Config:** texting style, Quiet Hours, Budgets, proactivity limits.

## Workspace layout

This is a direction, not a fixed plan. The rules, the stages, and the Turborepo setup are in [decision 0001](../decisions/0001-repository-foundation.md).

- `apps/`: deployable units. `agent` in the MVP; `mobile`, `site`, and `platform` later.
- `packages/`: code that at least two workspaces need. `create-assistant` in the MVP; `contracts`, `plugin-sdk`, and `tsconfig` when a second consumer exists.
- `plugins/`: Channels that a fork can add or remove. Telegram moves here when the second Channel arrives.

In the MVP, the agent code is in `apps/agent/src`, with one module for each domain area: `edge`, `directory`, `personal-agent`, `channels/telegram`, `memory`, `journal`, `schedule`, `proactivity`, `behavior`, `model-gateway`, and `tracing`. Evals live in `apps/agent/evals`.
